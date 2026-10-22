use super::Hub;
use super::grants::{internal_error, require};
use crate::hub::store::StoreError;
use fleetd_contracts::auth::{AgentKeyInfo, Role};
use fleetd_contracts::mcp::{McpToolError, McpToolName};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// The verified key behind a request: checked again on every MCP request and app `call`, so a revoked key stops at
/// its next one.
pub type Caller = AgentKeyInfo;

/// A tool failure in the spec's `{ code, message, fix }` shape. Every one says what to do next.
pub type ToolError = McpToolError;

pub type ToolFuture = Pin<Box<dyn Future<Output = Result<Value, CallError>> + Send>>;
type Handler = Arc<dyn Fn(Arc<Hub>, Caller, Value) -> ToolFuture + Send + Sync>;

/// Why a call produced no output. The transports word `UnknownTool` and `Invalid` themselves: MCP answers an unknown
/// tool with a JSON-RPC error and the app with `not_found`, and their invalid-input fixes differ.
#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    UnknownTool,
    /// The input did not decode against the tool's schema; the decoder's message.
    Invalid(String),
    Tool(ToolError),
}

impl From<ToolError> for CallError {
    fn from(error: ToolError) -> Self {
        Self::Tool(error)
    }
}

/// Store failures are defects: logged, and answered with the generic `failed`.
impl From<StoreError> for ToolError {
    fn from(error: StoreError) -> Self {
        tracing::error!(%error, "tool call failed");
        internal_error()
    }
}

struct Tool {
    scope: Role,
    handler: Handler,
}

/// MCP tool name → handler. Built once by `api::registry()`; `/mcp` and `/app` both call through it.
#[derive(Default)]
pub struct Registry {
    tools: HashMap<&'static str, Tool>,
}

impl Registry {
    /// Registers `name` with a typed handler: the input decodes from the call's JSON (missing arguments are `{}`)
    /// with the contract's defaults and checks, then the key must hold the tool's role from the contracts table,
    /// then the handler runs and its output is encoded. Replaces an earlier registration of `name`.
    ///
    /// Panics if `name` is not in the contracts tool table: that is a programming error caught at startup.
    pub fn add<I, O, F, Fut>(&mut self, name: &'static str, handler: F)
    where
        I: DeserializeOwned + Send + 'static,
        O: Serialize + 'static,
        F: Fn(Arc<Hub>, Caller, I) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<O, ToolError>> + Send + 'static,
    {
        let scope = Self::scope_of(name);
        let handler = Arc::new(handler);
        let erased: Handler = Arc::new(move |hub, caller, input| {
            let handler = handler.clone();
            Box::pin(async move {
                let input: I =
                    serde_json::from_value(input).map_err(|e| CallError::Invalid(e.to_string()))?;
                require(&caller, scope, None)?;
                let output = handler(hub, caller, input).await?;
                serde_json::to_value(output)
                    .map_err(|e| CallError::Tool(ToolError::from(StoreError::from(e))))
            })
        });
        self.tools.insert(
            name,
            Tool {
                scope,
                handler: erased,
            },
        );
    }

    /// Registers `name` with a handler that takes the raw JSON input and decodes it itself; the role check from the
    /// contracts table still runs first. chat_stop uses it to check the key before the input.
    pub fn add_raw<F, Fut>(&mut self, name: &'static str, handler: F)
    where
        F: Fn(Arc<Hub>, Caller, Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, ToolError>> + Send + 'static,
    {
        let scope = Self::scope_of(name);
        let handler = Arc::new(handler);
        let erased: Handler = Arc::new(move |hub, caller, input| {
            let handler = handler.clone();
            Box::pin(async move {
                require(&caller, scope, None)?;
                Ok(handler(hub, caller, input).await?)
            })
        });
        self.tools.insert(
            name,
            Tool {
                scope,
                handler: erased,
            },
        );
    }

    fn scope_of(name: &'static str) -> Role {
        McpToolName::parse(name)
            .map(McpToolName::scope)
            .unwrap_or_else(|| panic!("tool {name} is not in the contracts tool table"))
    }

    pub fn contains(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    /// The minimum role of a registered tool.
    pub fn scope(&self, name: &str) -> Option<Role> {
        self.tools.get(name).map(|t| t.scope)
    }

    /// Registered tool names.
    pub fn names(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.tools.keys().copied()
    }

    /// Runs one call for an already verified caller. `null` input (MCP `arguments` absent) decodes as `{}`. The
    /// handler runs on its own task so a panic becomes the generic `failed` instead of dropping the connection;
    /// dropping the returned future (the client went away) aborts it.
    pub async fn call(
        &self,
        hub: &Arc<Hub>,
        caller: &Caller,
        tool: &str,
        input: Value,
    ) -> Result<Value, CallError> {
        let Some(entry) = self.tools.get(tool) else {
            return Err(CallError::UnknownTool);
        };
        let input = if input.is_null() {
            Value::Object(Default::default())
        } else {
            input
        };
        let mut task = AbortOnDrop(tokio::spawn((entry.handler)(
            hub.clone(),
            caller.clone(),
            input,
        )));
        match task.join().await {
            Ok(result) => result,
            Err(error) => {
                tracing::error!(tool, %error, "tool call failed");
                Err(CallError::Tool(internal_error()))
            }
        }
    }
}

struct AbortOnDrop<T>(tokio::task::JoinHandle<T>);

impl<T> AbortOnDrop<T> {
    async fn join(&mut self) -> Result<T, tokio::task::JoinError> {
        (&mut self.0).await
    }
}

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}
