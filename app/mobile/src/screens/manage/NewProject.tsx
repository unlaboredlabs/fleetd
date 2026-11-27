// New Bot, a sheet from the Chats list's +, as the desktop's New bot: what to call it, and its repos, none, one or
// several: Add Repo opens a field (owner/repo, a GitHub URL, or a folder already on the machine) with what the hub
// found under it (project_discover: checkouts on the bot's machine, the person's GitHub repos); a repo comes out with
// its ✕ before creating. Then which machine, when there are several. Create runs the desktop's own flow (create.ts):
// the bot first, then each repo, a clone's progress, ✓, or why it failed with Retry. A bot with no repo opens its chat
// at once.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { botAtFolder, botHolding, botName, createBusy, createStep, typedRepo, type ProjectRef, type ProjectSummary, initialCreate, NAME_MAX, nameProblem, needsUpdate, otherHost, projectHome, repoKey, repoSuggestions, target, tilde, type CopyChoice, type CreateMsg, type CreateState, type RepoDraft, type RepoJob, type RepoPick } from "../../desktop";
import { useHub, type RootParams } from "../../hubContext";
import { keyOf } from "../../store";
import { space, type, useTheme } from "../../theme";
import { Button } from "../../ui/Button";
import { haptics } from "../../ui/haptics";
import { Icon } from "../../ui/Icon";
import { ListRow, ListSection } from "../../ui/List";
import { createCall, discover } from "./api";
import { closeThenOpen } from "./arrival";
import { createRefusal, machineName, NOT_CONNECTED, onlineNow, refusalNow } from "./model";
import { CheckRow, errorWords, FieldRow, Note, Problem, sheetOptions, Symbol, useRead } from "./parts";

type Props = NativeStackScreenProps<RootParams, "NewProject">;

/** How many of what the hub found show under the add field. */
const SUGGESTIONS_SHOWN = 8;

export function NewProject({ navigation, route }: Props) {
  const t = useTheme();
  const { state, session, paired } = useHub();
  const names = useCallback((id: string) => machineName(state.machines, id, paired.cloud === true), [state.machines, paired.cloud]);
  // The agents' Mac is no bot's home: neither offered nor searched.
  const home = useCallback((id: string) => projectHome(state.machines.find((m) => m.machineId === id)), [state.machines]);
  const found = useRead(() => discover(session, names, home), [session]);
  const d = found.value?.ok === true ? found.value.value : null;
  const [name, setName] = useState("");
  const [repos, setRepos] = useState<readonly RepoDraft[]>([]);
  // The add field's text; null while it is closed.
  const [adding, setAdding] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [refused, setRefused] = useState<string>();

  // The bot and its repos, as the desktop makes them: messages in, its calls out.
  const flow = useRef<CreateState>({ ...initialCreate, live: state.hub.phase === "live" });
  const [s, setS] = useState(flow.current);
  const send = useCallback(
    (msg: CreateMsg) => {
      const [next, calls] = createStep(flow.current, msg);
      flow.current = next;
      setS(next);
      for (const call of calls) void createCall(session, call).then((outcome) => send({ t: "answer", call, outcome }));
    },
    [session],
  );
  useEffect(() => session.onEvent((event) => send({ t: "event", event })), [session, send]);
  const live = state.hub.phase === "live";
  useEffect(() => send({ t: "live", live }), [live, send]);
  // Back online: Create's "Not connected" no longer holds.
  useEffect(() => setRefused((now) => refusalNow(now, live)), [live]);
  // After a drop, the next snapshot says which repos came in meanwhile.
  useEffect(() => {
    if (state.projects !== undefined) send({ t: "snapshot", projects: Object.values(state.projects) });
  }, [state.projects, send]);

  const workers = onlineNow(d?.workers ?? state.machines.filter(projectHome).map((m) => ({ machineId: m.machineId, name: m.name, online: m.status !== "offline" })), state.machines);
  const to = target(d, picked) ?? workers[0] ?? null;
  const nameIssue = nameProblem(name);
  const named = botName(name, repos);
  // A machine whose node can't make a bot's folder takes one listed, or typed in the add field.
  const toWorker = d?.workers.find((w) => w.machineId === to?.machineId);
  const block = to === null ? "Nothing that runs agents is online: start fleetd on one of your computers, or connect one in the desktop app." : toWorker === undefined ? undefined : (needsUpdate(toWorker, repos, adding) ?? undefined);
  const create = () => {
    if (nameIssue !== undefined) return;
    // A repo typed but not yet added goes in with the rest, or Create says why it can't.
    const typed = adding === null ? null : typedRepo(adding);
    const typedBot = typed !== null && "repo" in typed && typed.repo.kind === "folder" ? botAtFolder(state.projects ?? {}, to?.machineId, typed.repo.path) : undefined;
    const all = typed !== null && "repo" in typed && !repos.some((x) => repoKey(x) === repoKey(typed.repo)) ? [...repos, typed.repo] : repos;
    const why = createRefusal({ live, typed, typedBot, block, named: botName(name, all) });
    if (live && typed !== null && "repo" in typed && typedBot === undefined) {
      setRepos(all);
      setAdding(null);
    }
    if (why !== undefined || to === null) {
      haptics.warning();
      setRefused(why);
      return;
    }
    haptics.tap();
    send({ t: "start", draft: { name: botName(name, all), machineId: to.machineId, repos: all } });
  };
  // The bar's ✓ is set once per phase, so it calls Create as it is now: with the field's text, the repos and the name typed since.
  const createNow = useRef(create);
  createNow.current = create;
  // Made from Import Memory: back there, where the paste waits. Else its chat.
  const openChat = (key: string) => (route.params?.back === true ? navigation.goBack() : closeThenOpen(navigation, key));
  const phase = s.phase;
  // Made with nothing to add, or all of it added at once: its chat opens.
  const done = phase.kind === "made" && s.jobs.every((j) => j.state.t === "added") ? keyOf(phase.bot.project) : undefined;
  useEffect(() => {
    if (done === undefined) return;
    haptics.success();
    openChat(done);
    // Once, as it is made.
  }, [done]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: phase.kind === "made" ? phase.bot.title : "New Bot",
      ...sheetOptions(
        t,
        () => navigation.goBack(),
        // Always the one ✓, only its job changing: Create, then Open Chat once the bot is made.
        phase.kind === "made"
          ? { label: "Open Chat", enabled: true, busy: false, onPress: () => openChat(keyOf(phase.bot.project)) }
          : // Never grey while the link is down: pressed, it says why (createRefusal), as the line under the form does.
            { label: "Create", enabled: phase.kind === "form", busy: phase.kind === "creating", onPress: () => createNow.current() },
      ),
    });
    // `openChat` reads what these are; Create reads the newest `create` through its ref.
  }, [navigation, t, phase]);

  const list = useMemo(() => (adding === null ? [] : repoSuggestions(adding, d, to?.machineId, repos.map(repoKey), SUGGESTIONS_SHOWN)), [adding, d, to?.machineId, repos]);

  if (phase.kind === "creating") {
    return (
      <View style={[styles.center, { backgroundColor: t.grouped }]}>
        <ActivityIndicator size="large" color={t.secondary} />
        <Text style={[type.title3, styles.text, { color: t.label }]}>{`Making ${phase.title}`}</Text>
      </View>
    );
  }
  if (phase.kind === "failed") {
    return (
      <View style={[styles.center, { backgroundColor: t.grouped }]}>
        <Symbol ios="exclamationmark.triangle.fill" android="warning" size={44} color={t.warning} />
        <Text style={[type.title3, styles.text, { color: t.label }]}>{`Couldn't create ${phase.title}`}</Text>
        <Text style={[type.subhead, styles.text, { color: t.secondary }]}>{errorWords(phase)}</Text>
        <View style={styles.actions}>
          <Button label="Back" onPress={() => send({ t: "back" })} />
        </View>
      </View>
    );
  }
  if (phase.kind === "made") {
    if (done !== undefined) return <View style={[styles.center, { backgroundColor: t.grouped }]} />;
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }} style={{ backgroundColor: t.grouped }}>
        <ListSection header="Repos" {...(createBusy(s) ? { footer: "It carries on if you close this." } : {})}>
          {s.jobs.map((j) => (
            <JobRow key={j.key} job={j} bot={phase.bot.project} projects={state.projects ?? {}} onRetry={(use) => send(use === undefined ? { t: "retry", key: j.key } : { t: "retry", key: j.key, use })} />
          ))}
        </ListSection>
      </ScrollView>
    );
  }

  const add = (r: RepoPick | undefined) => {
    if (r === undefined) return;
    if (r.kind === "folder" && !r.path.startsWith("/")) return setRefused("Type the folder's full path, starting with /.");
    // A folder that is a bot already would take that bot's place: not added.
    const bot = r.kind === "folder" ? botAtFolder(state.projects ?? {}, to?.machineId, r.path) : undefined;
    if (r.kind === "folder" && bot !== undefined) return setRefused(`${tilde(r.path)} is already the bot ${bot.title}: open it from Chats.`);
    haptics.select();
    setRefused(undefined);
    setRepos((now) => (now.some((x) => repoKey(x) === repoKey(r)) ? now : [...now, r.kind === "clone" ? { kind: "clone", repo: r.repo } : { kind: "folder", path: r.path }]));
    setAdding(null);
  };
  const other = adding === null ? null : otherHost(adding);
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: space.xxl }} style={{ backgroundColor: t.grouped }}>
      <ListSection header="Name">
        <FieldRow
          value={name}
          onChangeText={(v) => {
            setName(v);
            setRefused(undefined);
          }}
          placeholder={named === "" ? "Name" : named}
          autoFocus
          maxLength={NAME_MAX + 1}
          autoCapitalize="words"
          returnKeyType="done"
          onSubmitEditing={create}
          accessibilityLabel="Name"
          invalid={nameIssue !== undefined}
        />
      </ListSection>
      <Problem text={nameIssue} />
      <ListSection header="Repos" {...(repos.length === 0 && adding === null ? { footer: "None: it works in a folder of its own." } : {})}>
        {[
          ...repos.map((r) => (
            <ListRow
              key={repoKey(r)}
              icon={r.kind === "clone" ? "link" : "folder"}
              title={r.kind === "clone" ? r.repo : tilde(r.path)}
              chevron={false}
              accessory={
                <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${r.kind === "clone" ? r.repo : tilde(r.path)}`} hitSlop={12} onPress={() => setRepos((now) => now.filter((x) => repoKey(x) !== repoKey(r)))}>
                  <Icon name="close" size={16} color={t.secondary} />
                </Pressable>
              }
            />
          )),
          adding === null ? (
            <ListRow key="add" icon="plus" title="Add Repo" chevron={false} onPress={() => setAdding("")} />
          ) : (
            <FieldRow
              key="field"
              value={adding}
              onChangeText={(v) => {
                setAdding(v);
                setRefused(undefined);
              }}
              placeholder="owner/repo, a URL or a folder's path"
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={() => add(list[0])}
              accessibilityLabel="Repo to add"
            />
          ),
        ]}
      </ListSection>
      {other !== null ? <Problem text={other} /> : null}
      {list.length > 0 ? (
        <ListSection header="Found">
          {list.map((r) => (
            <ListRow
              key={repoKey(r)}
              icon={r.kind === "folder" ? "folder" : "link"}
              title={r.kind === "clone" ? r.repo : (r.path.split("/").pop() ?? r.path)}
              detail={r.detail}
              chevron={false}
              onPress={() => add(r)}
            />
          ))}
        </ListSection>
      ) : adding !== null && found.reading ? (
        <View style={styles.reading}>
          <ActivityIndicator color={t.secondary} />
        </View>
      ) : null}
      {workers.length > 1 ? (
        <ListSection header="Machine">
          {workers.map((w) => (
            <CheckRow
              key={w.machineId}
              title={w.name}
              checked={w.machineId === to?.machineId}
              onPress={() => {
                haptics.select();
                setPicked(w.machineId);
              }}
            />
          ))}
        </ListSection>
      ) : null}
      <Problem text={refused ?? (live ? block : NOT_CONNECTED)} />
      {found.value?.ok === false && adding !== null ? <Problem text={`Nothing found to suggest: ${errorWords(found.value.error)}`} /> : null}
      {d !== null && d.problems.length > 0 && adding !== null && list.length === 0 ? <Note>{d.problems.map((p) => errorWords(p)).join(" ")}</Note> : null}
    </ScrollView>
  );
}

/**
 * A repo coming in: its progress, ✓, or why it failed with Retry; a copy already in a clone's way is used as it is or
 * copied next to it. An older hub archives a bot whose folder it is when it is used, so only a copy is offered then.
 */
function JobRow({ job, bot, projects, onRetry }: { job: RepoJob; bot: ProjectRef; projects: Readonly<Record<string, ProjectSummary>>; onRetry: (use?: CopyChoice) => void }) {
  const t = useTheme();
  const st = job.state;
  const title = job.draft.kind === "clone" ? job.draft.repo : tilde(job.draft.path);
  const holder = st.t === "failed" && st.existing === true && st.unused !== true && job.draft.kind === "clone" ? botHolding(projects, bot.machineId, job.draft.repo, st.at, bot.projectId) : undefined;
  const archived = st.t === "added" && st.archived !== undefined ? (projects[keyOf(st.archived)]?.title ?? st.archived.projectId) : undefined;
  const detail =
    st.t === "adding"
      ? st.detail
      : st.t === "failed"
        ? `${errorWords(st)}${holder === undefined ? "" : ` It is the bot ${holder.title}'s.`}`
        : st.t === "waiting"
          ? "Waiting for the bot"
          : archived === undefined
            ? undefined
            : `${archived} archived: its chat stays`;
  return (
    <ListRow
      icon={job.draft.kind === "clone" ? "link" : "folder"}
      title={title}
      detail={detail}
      chevron={false}
      accessory={
        st.t === "added" ? (
          <Symbol ios="checkmark.circle.fill" android="check_circle" size={20} color={t.success} />
        ) : st.t === "failed" && st.existing === true ? (
          <Button label="Add" kind="tinted" size="small" onPress={() => chooseCopy(st.at, holder === undefined, onRetry)} />
        ) : st.t === "failed" ? (
          <Button label="Retry" kind="tinted" size="small" onPress={() => onRetry()} />
        ) : (
          <ActivityIndicator color={t.secondary} />
        )
      }
    />
  );
}

/** A clone whose folder already holds the repo: use that copy, or make a separate one beside it (only that on an older
 * hub, where using a bot's folder archives that bot). */
function chooseCopy(at: string | undefined, same: boolean, onRetry: (use?: CopyChoice) => void) {
  Alert.alert("There's Already a Copy", at === undefined ? undefined : tilde(at), [
    ...(same ? [{ text: "Use the Same Copy", isPreferred: true, onPress: () => onRetry("same") }] : []),
    { text: "Make a Separate Copy", onPress: () => onRetry("copy") },
    { text: "Cancel", style: "cancel" as const },
  ]);
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, paddingHorizontal: space.xxl },
  text: { textAlign: "center" },
  actions: { alignSelf: "stretch", gap: space.sm, marginTop: space.md },
  reading: { paddingVertical: space.xl },
});
