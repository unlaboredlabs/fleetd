// New Bot, a sheet from the Chats list's +, as the desktop's New bot: what to call it, and its repos, none, one or
// several: Add Repo opens a field (owner/repo, a GitHub URL, or a folder already on the machine) with what the hub
// found under it (project_discover: checkouts on the bot's machine, the person's GitHub repos); a repo comes out with
// its ✕ before creating. Then which machine, when there are several. Create runs the desktop's own flow (create.ts):
// the bot first, then each repo, a clone's progress, ✓, or why it failed with Retry. A bot with no repo opens its chat
// at once.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { botName, createBusy, createStep, initialCreate, NAME_MAX, nameProblem, otherHost, ownRepo, projectHome, repoKey, repoSuggestions, target, tilde, type CreateMsg, type CreateState, type RepoDraft, type RepoJob, type RepoPick } from "../../desktop";
import { useHub, type RootParams } from "../../hubContext";
import { keyOf } from "../../store";
import { space, type, useTheme } from "../../theme";
import { Button } from "../../ui/Button";
import { haptics } from "../../ui/haptics";
import { Icon } from "../../ui/Icon";
import { ListRow, ListSection } from "../../ui/List";
import { createCall, discover } from "./api";
import { closeThenOpen } from "./arrival";
import { machineName } from "./model";
import { CheckRow, errorWords, FieldRow, Note, Problem, sheetOptions, Symbol, useRead } from "./parts";

type Props = NativeStackScreenProps<RootParams, "NewProject">;

/** How many of what the hub found show under the add field. */
const SUGGESTIONS_SHOWN = 8;

export function NewProject({ navigation, route }: Props) {
  const t = useTheme();
  const { state, session } = useHub();
  const names = useCallback((id: string) => machineName(state.machines, id), [state.machines]);
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
  // After a drop, the next snapshot says which repos came in meanwhile.
  useEffect(() => {
    if (state.projects !== undefined) send({ t: "snapshot", projects: Object.values(state.projects) });
  }, [state.projects, send]);

  const workers = (d?.workers ?? state.machines.filter(projectHome).map((m) => ({ machineId: m.machineId, name: m.name, online: m.status !== "offline" }))).filter((w) => w.online);
  const to = target(d, picked) ?? workers[0] ?? null;
  const nameIssue = nameProblem(name);
  const named = botName(name, repos);
  // With no folder of its own listed, its machine makes one, which a node from before W123 can't.
  const block =
    to === null
      ? "No machine is online to make it on: start fleetd on one of your machines."
      : ownRepo(repos) === undefined && d !== null && d.workers.some((w) => w.machineId === to.machineId && w.projectsRoot === undefined)
        ? `Update fleetd on ${to.name} to make a bot there, or add a folder that's already on it.`
        : undefined;
  const create = () => {
    if (nameIssue !== undefined) return;
    const why = block ?? (named === "" ? "Name it, or add a repo." : undefined);
    if (why !== undefined || to === null) {
      haptics.warning();
      setRefused(why);
      return;
    }
    haptics.tap();
    send({ t: "start", draft: { name: named, machineId: to.machineId, repos } });
  };
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
          : { label: "Create", enabled: phase.kind === "form" && live, busy: phase.kind === "creating", onPress: create },
      ),
    });
    // `create` and `openChat` read what these are.
  }, [navigation, t, phase, live, name, repos, to?.machineId, block]);

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
            <JobRow key={j.key} job={j} onRetry={(useExisting) => send({ t: "retry", key: j.key, useExisting })} />
          ))}
        </ListSection>
      </ScrollView>
    );
  }

  const add = (r: RepoPick | undefined) => {
    if (r === undefined) return;
    if (r.kind === "folder" && !r.path.startsWith("/")) return setRefused("Type the folder's full path, starting with /.");
    // A folder that is a bot already would take that bot's place: not added.
    if (r.kind === "folder") {
      const path = r.path.replace(/(.)\/+$/u, "$1");
      const bot = Object.values(state.projects ?? {}).find((p) => p.machineId === to?.machineId && p.workspaceRoot === path);
      if (bot !== undefined) return setRefused(`${tilde(path)} is already the bot ${bot.title}: open it from Chats.`);
    }
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
              tint={r.kind === "clone" ? t.tints[6] : t.tints[2]}
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
            <ListRow key="add" icon="plus" tint={t.accentDeep} title="Add Repo" chevron={false} onPress={() => setAdding("")} />
          ) : (
            <FieldRow
              key="field"
              value={adding}
              onChangeText={setAdding}
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
              tint={r.kind === "folder" ? t.tints[2] : t.tints[6]}
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
      <Problem text={refused ?? block} />
      {found.value?.ok === false && adding !== null ? <Problem text={`Nothing found to suggest: ${errorWords(found.value.error)}`} /> : null}
      {d !== null && d.problems.length > 0 && adding !== null && list.length === 0 ? <Note>{d.problems.map((p) => errorWords(p)).join(" ")}</Note> : null}
    </ScrollView>
  );
}

/** A repo coming in: its progress, ✓, or why it failed with Retry (or the checkout already there). */
function JobRow({ job, onRetry }: { job: RepoJob; onRetry: (useExisting: boolean) => void }) {
  const t = useTheme();
  const st = job.state;
  const title = job.draft.kind === "clone" ? job.draft.repo : tilde(job.draft.path);
  const detail = st.t === "adding" ? st.detail : st.t === "failed" ? errorWords(st) : st.t === "waiting" ? "Waiting for the bot" : undefined;
  return (
    <ListRow
      icon={job.draft.kind === "clone" ? "link" : "folder"}
      tint={job.draft.kind === "clone" ? t.tints[6] : t.tints[2]}
      title={title}
      detail={detail}
      chevron={false}
      accessory={
        st.t === "added" ? (
          <Symbol ios="checkmark.circle.fill" android="check_circle" size={20} color={t.success} />
        ) : st.t === "failed" ? (
          <Button label={st.existing === true ? "Use Checkout" : "Retry"} kind="tinted" size="small" onPress={() => onRetry(st.existing === true)} />
        ) : (
          <ActivityIndicator color={t.secondary} />
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, paddingHorizontal: space.xxl },
  text: { textAlign: "center" },
  actions: { alignSelf: "stretch", gap: space.sm, marginTop: space.md },
  reading: { paddingVertical: space.xl },
});
