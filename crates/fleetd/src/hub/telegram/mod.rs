//! A Navi's Telegram bridge (W237, decision navi.telegram; the wire types are `telegram.rs`). Its owner sets it up in
//! the Navi's settings: makes a bot with @BotFather, pastes the token (sealed in the app to the Navi's machine; the hub
//! relays the box and keeps the fingerprint, never the token), presses Test (getMe: the bot's name and photo), then
//! Pair, which opens `t.me/<bot>?start=<code>`; their Start makes their account the one the Navi answers. Unpair and
//! pair again, pause, or remove it from the same place.
//!
//! The Navi's node holds the token and long-polls Telegram (node/telegram). The hub's part is [`run`]: it takes what the
//! paired account sent from the node's journal into the Navi's chat (marked as from Telegram, a forward as someone
//! else's words), answers approval buttons as the owner, and sends the Navi's replies and approval cards back. Rows:
//! `telegram_bridges` (the bridge as the tools show it, the journal seq taken and the chat seq sent), and
//! `telegram_cards` (each approval card sent, by request, to update it once answered anywhere).
pub mod format;
pub mod run;
#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::mcp::{
    ErrorCode, TelegramGetInput, TelegramGetOutput, TelegramPairInput, TelegramPairOutput,
    TelegramPauseInput, TelegramPauseOutput, TelegramRemoveInput, TelegramRemoveOutput,
    TelegramSetInput, TelegramSetOutput, TelegramTestInput, TelegramTestOutput,
    TelegramUnpairInput, TelegramUnpairOutput,
};
use fleetd_contracts::node_link::CAP_TELEGRAM;
use fleetd_contracts::prim::{Line, Text, True};
use fleetd_contracts::telegram::{
    TELEGRAM_PAIR_SECS, TelegramAnswer, TelegramBridge, TelegramCall, TelegramNode,
};
use rand::RngCore;
use rusqlite::{OptionalExtension, params};

use crate::hub::api::{Caller, Hub, Registry, ToolError, error, is_human, offline, require};
use crate::hub::executor::tools::from_executor;
use crate::hub::store::{HubDb, StoreError, iso_ms, now_ms};

/// A call that should answer at once.
const CALL_WAIT: Duration = Duration::from_secs(15);
/// Test asks Telegram twice and fetches a photo.
const TEST_WAIT: Duration = Duration::from_secs(60);

pub fn register(tools: &mut Registry) {
    tools.add("telegram_get", get);
    tools.add("telegram_set", set);
    tools.add("telegram_test", test);
    tools.add("telegram_pair", pair);
    tools.add("telegram_unpair", unpair);
    tools.add("telegram_pause", pause);
    tools.add("telegram_remove", remove);
}

/// One bridge's row.
#[derive(Clone, Debug)]
pub struct Row {
    pub navi: ProjectRef,
    pub bridge: TelegramBridge,
    /// The node journal's last seq handled.
    pub taken: i64,
    /// The chat's last seq sent to Telegram (or passed over).
    pub sent: i64,
}

pub fn row(db: &HubDb, r: &ProjectRef) -> Result<Option<Row>, StoreError> {
    let found: Option<(String, i64, i64)> = db.with(|c| {
        Ok(c.query_row(
            "SELECT data, taken, sent FROM telegram_bridges WHERE machine_id = ? AND project_id = ?",
            params![r.machine_id.as_str(), r.project_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?)
    })?;
    Ok(found.and_then(|(data, taken, sent)| {
        Some(Row {
            navi: r.clone(),
            bridge: serde_json::from_str(&data).ok()?,
            taken,
            sent,
        })
    }))
}

pub fn rows(db: &HubDb) -> Result<Vec<Row>, StoreError> {
    let refs: Vec<(String, String)> = db.with(|c| {
        let mut stmt = c.prepare("SELECT machine_id, project_id FROM telegram_bridges")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })?;
    let mut out = Vec::new();
    for (m, p) in refs {
        let r = ProjectRef {
            machine_id: fleetd_contracts::ids::MachineId::unchecked(m),
            project_id: fleetd_contracts::ids::ProjectId::unchecked(p),
        };
        if let Some(row) = row(db, &r)? {
            out.push(row);
        }
    }
    Ok(out)
}

pub fn put_bridge(db: &HubDb, r: &ProjectRef, bridge: &TelegramBridge) -> Result<(), StoreError> {
    let data = serde_json::to_string(&TelegramBridge {
        offline: false,
        ..bridge.clone()
    })?;
    db.with(|c| {
        c.execute(
            "INSERT INTO telegram_bridges (machine_id, project_id, data, taken, sent) VALUES (?, ?, ?, 0, 0)
             ON CONFLICT (machine_id, project_id) DO UPDATE SET data = excluded.data",
            params![r.machine_id.as_str(), r.project_id.as_str(), data],
        )?;
        Ok(())
    })
}

pub fn set_taken(db: &HubDb, r: &ProjectRef, taken: i64) -> Result<(), StoreError> {
    db.with(|c| {
        c.execute(
            "UPDATE telegram_bridges SET taken = ? WHERE machine_id = ? AND project_id = ?",
            params![taken, r.machine_id.as_str(), r.project_id.as_str()],
        )?;
        Ok(())
    })
}

pub fn set_sent(db: &HubDb, r: &ProjectRef, sent: i64) -> Result<(), StoreError> {
    db.with(|c| {
        c.execute(
            "UPDATE telegram_bridges SET sent = MAX(sent, ?) WHERE machine_id = ? AND project_id = ?",
            params![sent, r.machine_id.as_str(), r.project_id.as_str()],
        )?;
        Ok(())
    })
}

/// Deletes a bridge's rows (its Navi went, or it was removed).
pub fn drop_rows(db: &HubDb, r: &ProjectRef) -> Result<(), StoreError> {
    db.with(|c| {
        for table in ["telegram_bridges", "telegram_cards"] {
            c.execute(
                &format!("DELETE FROM {table} WHERE machine_id = ? AND project_id = ?"),
                params![r.machine_id.as_str(), r.project_id.as_str()],
            )?;
        }
        Ok(())
    })
}

/// The chat's newest seq: a new bridge starts sending after it, never what came before.
pub(crate) fn chat_head(db: &HubDb, r: &ProjectRef) -> Result<i64, StoreError> {
    db.with(|c| {
        Ok(c.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM chat_messages WHERE machine_id = ? AND project_id = ?",
            params![r.machine_id.as_str(), r.project_id.as_str()],
            |row| row.get(0),
        )?)
    })
}

/// The bridge with what its node says now.
pub fn merged(bridge: &TelegramBridge, node: &TelegramNode) -> TelegramBridge {
    TelegramBridge {
        bot: node.bot.clone().or_else(|| bridge.bot.clone()),
        paired: node.paired.clone(),
        pairing: node.pairing,
        paused: node.paused,
        status: Some(node.status.clone()),
        offline: false,
        ..bridge.clone()
    }
}

/// The Navi a call names, for its owner on one of their devices: a person's own key, on a Navi.
fn navi_of(hub: &Hub, caller: &Caller, r: &ProjectRef, role: Role) -> Result<(), ToolError> {
    require(caller, role, Some(&r.machine_id))?;
    if !is_human(caller) {
        return Err(error(
            ErrorCode::Forbidden,
            "Only a person sets up their Navi's Telegram, from one of their own devices.",
            "Open the Navi's settings in the fleetd app.",
        ));
    }
    if crate::hub::navi::of(&hub.db, r)?.is_none() {
        return Err(error(
            ErrorCode::Invalid,
            format!("{} on {} is not a Navi.", r.project_id, r.machine_id),
            "Telegram connects to a Navi only: navi_list shows yours.",
        ));
    }
    // Another person's Navi is refused before any handler (navi::owner::guard).
    Ok(())
}

/// The Navi's node can run a bridge now: online and new enough.
fn node_ready(hub: &Hub, r: &ProjectRef) -> Result<(), ToolError> {
    let m = &r.machine_id;
    if !hub.executors.is_connected(m) {
        return Err(offline(m));
    }
    if !hub.link.node_can(m, CAP_TELEGRAM) {
        return Err(error(
            ErrorCode::Invalid,
            format!("{m}'s node is too old for Telegram."),
            format!("Update fleetd on {m} and restart its node."),
        ));
    }
    Ok(())
}

pub(crate) async fn node_call(
    hub: &Hub,
    r: &ProjectRef,
    call: TelegramCall,
    wait: Duration,
) -> Result<TelegramAnswer, ToolError> {
    node_ready(hub, r)?;
    hub.executors
        .telegram(&r.machine_id, &r.project_id, call, wait)
        .await
        .map_err(from_executor)
}

fn saved(hub: &Hub, r: &ProjectRef) -> Result<Row, ToolError> {
    row(&hub.db, r)?.ok_or_else(|| {
        error(
            ErrorCode::NotFound,
            "This Navi has no Telegram bot yet.",
            "Make a bot with @BotFather and paste its token first.",
        )
    })
}

/// The node's state of the bridge, kept on its row; the row as it was when the node can't say.
async fn refreshed(hub: &Hub, r: &ProjectRef, row: Row) -> Result<TelegramBridge, ToolError> {
    if node_ready(hub, r).is_err() {
        return Ok(TelegramBridge {
            offline: true,
            ..row.bridge
        });
    }
    match node_call(hub, r, TelegramCall::State, CALL_WAIT).await {
        Ok(TelegramAnswer::State { state }) => keep(hub, r, &row.bridge, &state),
        _ => Ok(TelegramBridge {
            offline: true,
            ..row.bridge
        }),
    }
}

fn keep(
    hub: &Hub,
    r: &ProjectRef,
    bridge: &TelegramBridge,
    node: &TelegramNode,
) -> Result<TelegramBridge, ToolError> {
    let now = merged(bridge, node);
    if &now != bridge {
        put_bridge(&hub.db, r, &now)?;
    }
    Ok(now)
}

fn state_of(answer: TelegramAnswer) -> Result<TelegramNode, ToolError> {
    match answer {
        TelegramAnswer::State { state } | TelegramAnswer::Taken { state, .. } => Ok(state),
        _ => Err(ToolError::new(
            ErrorCode::Failed,
            "The node's answer wasn't the bridge's state.",
        )),
    }
}

async fn get(
    hub: Arc<Hub>,
    caller: Caller,
    input: TelegramGetInput,
) -> Result<TelegramGetOutput, ToolError> {
    let r = &input.navi;
    navi_of(&hub, &caller, r, Role::Read)?;
    let bridge = match row(&hub.db, r)? {
        Some(row) => Some(refreshed(&hub, r, row).await?),
        None => None,
    };
    Ok(TelegramGetOutput {
        bridge,
        next: None,
        truncated: None,
    })
}

async fn set(
    hub: Arc<Hub>,
    caller: Caller,
    input: TelegramSetInput,
) -> Result<TelegramSetOutput, ToolError> {
    let r = &input.navi;
    navi_of(&hub, &caller, r, Role::Operate)?;
    let answer = node_call(
        &hub,
        r,
        TelegramCall::Token {
            sealed: Some(input.sealed.clone()),
        },
        CALL_WAIT,
    )
    .await?;
    let TelegramAnswer::Saved {
        fingerprint: Some(fingerprint),
    } = answer
    else {
        return Err(ToolError::new(ErrorCode::Failed, "The node kept no token."));
    };
    let bridge = TelegramBridge {
        fingerprint,
        saved_at: Timestamp(iso_ms(now_ms(hub.clock.as_ref()))),
        bot: None,
        paired: None,
        pairing: false,
        paused: false,
        status: None,
        offline: false,
    };
    // A new bot starts afresh: its cards are another bot's messages, and only what the chat says from now on goes.
    drop_rows(&hub.db, r)?;
    put_bridge(&hub.db, r, &bridge)?;
    set_sent(&hub.db, r, chat_head(&hub.db, r)?)?;
    hub.telegram.wake();
    Ok(TelegramSetOutput {
        bridge,
        next: Some(
            "Press Test to see the bot Telegram answers for, then Pair to connect your account."
                .into(),
        ),
        truncated: None,
    })
}

async fn test(
    hub: Arc<Hub>,
    caller: Caller,
    input: TelegramTestInput,
) -> Result<TelegramTestOutput, ToolError> {
    let r = &input.navi;
    navi_of(&hub, &caller, r, Role::Operate)?;
    let row = saved(&hub, r)?;
    let TelegramAnswer::Tested { bot, error } =
        node_call(&hub, r, TelegramCall::Test, TEST_WAIT).await?
    else {
        return Err(ToolError::new(
            ErrorCode::Failed,
            "The node sent no test result.",
        ));
    };
    if let Some(bot) = &bot {
        put_bridge(
            &hub.db,
            r,
            &TelegramBridge {
                bot: Some(bot.clone()),
                ..row.bridge
            },
        )?;
    }
    let next = error.is_some().then(|| {
        "Copy the token from @BotFather again (/mybots › your bot › API Token) and paste it.".into()
    });
    Ok(TelegramTestOutput {
        bot,
        error: error.map(|e| Text::unchecked(e.chars().take(500).collect::<String>())),
        next,
        truncated: None,
    })
}

/// A pairing code: 24 characters a Start link carries as they are.
fn code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut random = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut random);
    random
        .iter()
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect()
}

async fn pair(
    hub: Arc<Hub>,
    caller: Caller,
    input: TelegramPairInput,
) -> Result<TelegramPairOutput, ToolError> {
    let r = &input.navi;
    navi_of(&hub, &caller, r, Role::Operate)?;
    let row = saved(&hub, r)?;
    let bot = match row.bridge.bot.clone() {
        Some(bot) => bot,
        None => match node_call(&hub, r, TelegramCall::Test, TEST_WAIT).await? {
            TelegramAnswer::Tested { bot: Some(bot), .. } => bot,
            TelegramAnswer::Tested { error, .. } => {
                return Err(error_of(error.unwrap_or_default()));
            }
            _ => {
                return Err(ToolError::new(
                    ErrorCode::Failed,
                    "The node sent no test result.",
                ));
            }
        },
    };
    let code = code();
    let state = state_of(
        node_call(
            &hub,
            r,
            TelegramCall::Pair {
                code: Line::unchecked(code.clone()),
            },
            CALL_WAIT,
        )
        .await?,
    )?;
    keep(
        &hub,
        r,
        &TelegramBridge {
            bot: Some(bot.clone()),
            ..row.bridge
        },
        &state,
    )?;
    let expires = now_ms(hub.clock.as_ref()) + TELEGRAM_PAIR_SECS * 1000;
    Ok(TelegramPairOutput {
        link: Line::unchecked(format!(
            "https://t.me/{}?start={code}",
            bot.username.as_str()
        )),
        expires_at: Timestamp(iso_ms(expires)),
        next: Some(
            "Open the link on the phone or computer you use Telegram on, and press Start.".into(),
        ),
        truncated: None,
    })
}

fn error_of(said: String) -> ToolError {
    error(
        ErrorCode::Failed,
        format!("Telegram didn't take the token: {said}"),
        "Copy the token from @BotFather again and paste it.",
    )
}

async fn unpair(
    hub: Arc<Hub>,
    caller: Caller,
    input: TelegramUnpairInput,
) -> Result<TelegramUnpairOutput, ToolError> {
    let r = &input.navi;
    navi_of(&hub, &caller, r, Role::Operate)?;
    let row = saved(&hub, r)?;
    let state = state_of(node_call(&hub, r, TelegramCall::Unpair, CALL_WAIT).await?)?;
    let bridge = keep(&hub, r, &row.bridge, &state)?;
    if let Some(was) = &row.bridge.paired {
        let _ = hub.chat.system_line(
            r,
            &format!(
                "Telegram unpaired: {} no longer reaches this Navi there.",
                was.name.as_str()
            ),
        );
    }
    Ok(TelegramUnpairOutput {
        bridge,
        next: Some("Press Pair to connect an account again.".into()),
        truncated: None,
    })
}

async fn pause(
    hub: Arc<Hub>,
    caller: Caller,
    input: TelegramPauseInput,
) -> Result<TelegramPauseOutput, ToolError> {
    let r = &input.navi;
    navi_of(&hub, &caller, r, Role::Operate)?;
    let row = saved(&hub, r)?;
    let state = state_of(
        node_call(
            &hub,
            r,
            TelegramCall::Pause {
                paused: input.paused,
            },
            CALL_WAIT,
        )
        .await?,
    )?;
    let bridge = keep(&hub, r, &row.bridge, &state)?;
    if !input.paused {
        // What the Navi said while paused stays in the app: Telegram picks up from now.
        set_sent(&hub.db, r, chat_head(&hub.db, r)?)?;
    }
    hub.telegram.wake();
    Ok(TelegramPauseOutput {
        bridge,
        next: None,
        truncated: None,
    })
}

async fn remove(
    hub: Arc<Hub>,
    caller: Caller,
    input: TelegramRemoveInput,
) -> Result<TelegramRemoveOutput, ToolError> {
    let r = &input.navi;
    navi_of(&hub, &caller, r, Role::Operate)?;
    saved(&hub, r)?;
    // The node must forget the token first: one left running would still read the person's messages.
    node_call(&hub, r, TelegramCall::Token { sealed: None }, CALL_WAIT).await?;
    drop_rows(&hub.db, r)?;
    hub.telegram.wake();
    Ok(TelegramRemoveOutput {
        ok: True,
        next: Some(
            "Its machine forgot the token. In @BotFather, /deletebot removes the bot itself."
                .into(),
        ),
        truncated: None,
    })
}
