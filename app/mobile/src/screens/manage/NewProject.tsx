// New Project, a sheet from the Chats list's +, as the desktop's Add project: a GitHub repo to clone (owner/repo or
// its URL) or a folder already on a machine, which machine, and what to call it. Under the field, what the hub found
// (project_discover: checkouts on the machines, the person's GitHub repos), filtered as you type; one already a project
// opens its chat. The add runs the desktop's own flow (flow.ts) over project_add and the clone's events: its progress,
// what the hub read of the repo once added, or why it failed, with adding the folder that's already there when that
// is the same repo.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { addSource, addStep, baseName, initialAdd, otherHost, target, tilde, type AddMsg, type AddState, type Found, type Ready, type Request } from "../../desktop";
import { useHub, type RootParams } from "../../hubContext";
import { keyOf } from "../../store";
import { space, type, useTheme } from "../../theme";
import { Button } from "../../ui/Button";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { addCall, discover } from "./api";
import { closeThenOpen } from "./arrival";
import { machineName, PROJECT_NAME_MAX, projectNameProblem, suggestions } from "./model";
import { CheckRow, errorWords, FieldRow, Note, Problem, sheetOptions, Symbol, useRead } from "./parts";

type Props = NativeStackScreenProps<RootParams, "NewProject">;

export function NewProject({ navigation }: Props) {
  const t = useTheme();
  const { state, session } = useHub();
  const names = useCallback((id: string) => machineName(state.machines, id), [state.machines]);
  const found = useRead(() => discover(session, names), [session]);
  const d = found.value?.ok === true ? found.value.value : null;
  const [text, setText] = useState("");
  // A checkout picked from the list is on its own machine.
  const [fixed, setFixed] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("");

  // The add, as the desktop runs it: messages in, its project_add calls out.
  const flow = useRef<AddState>({ ...initialAdd, live: state.hub.phase === "live" });
  const [phase, setPhase] = useState(flow.current.phase);
  const title = useRef("");
  const send = useCallback(
    (msg: AddMsg) => {
      const [next, calls] = addStep(flow.current, msg, names);
      flow.current = next;
      setPhase(next.phase);
      for (const call of calls) void addCall(session, call, title.current).then((outcome) => send({ t: "answer", call, outcome }));
    },
    [session, names],
  );
  useEffect(() => session.onEvent((event) => send({ t: "event", event })), [session, send]);
  const live = state.hub.phase === "live";
  useEffect(() => send({ t: "live", live }), [live, send]);
  // After a drop, the next snapshot says whether it was added meanwhile.
  useEffect(() => {
    if (state.projects !== undefined && flow.current.lost) send({ t: "snapshot", projects: Object.values(state.projects) });
  }, [state.projects, send]);

  const workers = (d?.workers ?? state.machines.map((m) => ({ machineId: m.machineId, name: m.name, online: m.status !== "offline" }))).filter((w) => w.online);
  const to = target(d, picked) ?? workers[0] ?? null;
  const machineId = fixed ?? picked ?? to?.machineId;
  const source = addSource(text);
  const request: Request | null =
    machineId === undefined || source === null
      ? null
      : source.kind === "github"
        ? { kind: "clone", repo: source.repo, machineId, useExisting: false }
        : { kind: "folder", machineId, path: source.path };
  const nameIssue = projectNameProblem(name);
  const ready = request !== null && nameIssue === undefined && live;
  const start = (r: Request) => {
    title.current = name.trim();
    haptics.tap();
    send({ t: "start", request: r, path: r.kind === "folder" ? r.path : "" });
  };
  const openChat = (key: string) => closeThenOpen(navigation, key);

  useLayoutEffect(() => {
    const k = phase.kind;
    navigation.setOptions({
      title: k === "ready" ? "Added" : "New Project",
      ...sheetOptions(
        t,
        () => navigation.goBack(),
        // Always the one ✓, only its job changing: Add, then Open Chat once added.
        k === "ready"
          ? { label: "Open Chat", enabled: true, busy: false, onPress: () => openChat(keyOf(phase.ready.project)) }
          : { label: "Add", enabled: k === "pick" && ready, busy: k === "working", onPress: () => request !== null && start(request) },
      ),
    });
    // `start` and `openChat` read what these are.
  }, [navigation, t, phase, ready, request?.kind, text, name, machineId]);

  const list = useMemo(() => suggestions(text, d), [text, d]);

  if (phase.kind === "working") {
    const job = phase.job;
    return (
      <View style={[styles.center, { backgroundColor: t.grouped }]}>
        <ActivityIndicator size="large" color={t.secondary} />
        <Text style={[type.title3, styles.text, { color: t.label }]}>{job.clone ? `Cloning ${job.what}` : `Adding ${job.what}`}</Text>
        <Text style={[type.subhead, styles.text, { color: t.secondary }]}>{job.detail}</Text>
        {job.fraction === undefined ? null : (
          <View style={[styles.track, { backgroundColor: t.fill }]}>
            <View style={[styles.bar, { backgroundColor: t.accentFill, width: `${String(Math.round(job.fraction * 100))}%` }]} />
          </View>
        )}
        <Text style={[type.footnote, styles.text, { color: t.tertiary }]}>{`On ${names(job.machineId)}. It carries on if you close this, and shows in Chats once added.`}</Text>
      </View>
    );
  }
  if (phase.kind === "ready") return <Added ready={phase.ready} name={title.current} onOpen={() => openChat(keyOf(phase.ready.project))} />;
  if (phase.kind === "failed" || phase.kind === "unlisted") {
    const failure = phase.kind === "failed" ? phase.failure : { message: `${phase.what} isn't listed yet.`, fix: "A clone may still be running: it shows in Chats once added. If it doesn't, try again." };
    const action = phase.kind === "failed" ? phase.failure.action : undefined;
    return (
      <View style={[styles.center, { backgroundColor: t.grouped }]}>
        <Symbol ios="exclamationmark.triangle.fill" android="warning" size={44} color={t.warning} />
        <Text style={[type.title3, styles.text, { color: t.label }]}>{phase.kind === "failed" ? `Couldn't add ${phase.what}` : "Not added yet"}</Text>
        <Text style={[type.subhead, styles.text, { color: t.secondary }]}>{errorWords(failure)}</Text>
        <View style={styles.actions}>
          {action?.kind === "use_existing" ? <Button label="Add the Folder That's There" onPress={() => start(action.request)} /> : null}
          {action?.kind === "open" ? <Button label="Open Its Chat" onPress={() => openChat(keyOf(action.project))} /> : null}
          <Button label="Back" kind={action === undefined ? "filled" : "plain"} onPress={() => send({ t: "back" })} />
        </View>
      </View>
    );
  }

  const pick = (f: Found) => {
    haptics.select();
    if (f.project !== undefined) return openChat(keyOf(f.project));
    if (f.source.kind === "checkout") {
      setText(f.source.path);
      setFixed(f.source.machineId);
    } else {
      setText(f.name);
      setFixed(null);
    }
  };
  const other = otherHost(text);
  const placeholderName = request === null ? "Name" : request.kind === "clone" ? baseName(request.repo) : baseName(request.path);
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: space.xxl }} style={{ backgroundColor: t.grouped }}>
      <ListSection header="Repo or folder">
        <FieldRow
          value={text}
          onChangeText={(v) => {
            setText(v);
            setFixed(null);
          }}
          placeholder="owner/repo, a GitHub URL or ~/folder"
          autoFocus
          autoCapitalize="none"
          keyboardType="url"
          returnKeyType="next"
          accessibilityLabel="Repo or folder"
        />
      </ListSection>
      {other === null ? (
        <Note>
          {request?.kind === "clone"
            ? `Clones ${request.repo} onto ${names(request.machineId)}.`
            : request?.kind === "folder"
              ? `Adds the folder ${tilde(request.path)} that's already on ${names(request.machineId)}.`
              : "A GitHub repo is cloned onto the machine; a folder must already be on it."}
        </Note>
      ) : (
        <Problem text={other} />
      )}
      <ListSection header="Name" footer="How fleetd shows it. Its folder keeps its own name.">
        <FieldRow value={name} onChangeText={setName} placeholder={placeholderName} maxLength={PROJECT_NAME_MAX + 1} autoCapitalize="words" accessibilityLabel="Name" invalid={nameIssue !== undefined} />
      </ListSection>
      <Problem text={nameIssue} />
      {workers.length > 1 && fixed === null ? (
        <ListSection header="Machine">
          {workers.map((w) => (
            <CheckRow
              key={w.machineId}
              title={w.name}
              checked={w.machineId === machineId}
              onPress={() => {
                haptics.select();
                setPicked(w.machineId);
              }}
            />
          ))}
        </ListSection>
      ) : null}
      {list.length > 0 ? (
        <ListSection header={text.trim() === "" ? "Found" : "Matches"}>
          {list.map((f) => (
            <ListRow
              key={`${f.source.kind === "checkout" ? `${f.source.machineId}:${f.source.path}` : f.name}`}
              icon={f.source.kind === "checkout" ? "folder" : f.private ? "lock" : "link"}
              tint={f.source.kind === "checkout" ? t.tints[2] : t.tints[6]}
              title={f.name}
              detail={f.project !== undefined ? "Already a project: opens its chat" : f.source.kind === "checkout" ? `${tilde(f.source.path)} on ${names(f.source.machineId)}` : f.detail === "" ? "GitHub" : f.detail}
              onPress={() => pick(f)}
            />
          ))}
        </ListSection>
      ) : found.reading ? (
        <View style={styles.reading}>
          <ActivityIndicator color={t.secondary} />
        </View>
      ) : null}
      {found.value?.ok === false ? <Problem text={`Nothing found to suggest: ${errorWords(found.value.error)}`} /> : null}
      {d !== null && d.problems.length > 0 && list.length === 0 && text.trim() === "" ? <Note>{d.problems.map((p) => errorWords(p)).join(" ")}</Note> : null}
    </ScrollView>
  );
}

/** Added: what the hub read of it, and the one line on what its lead will need. */
function Added({ ready, name, onOpen }: { ready: Ready; name: string; onOpen: () => void }) {
  const t = useTheme();
  const shown = name === "" ? ready.title : name;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }} style={{ backgroundColor: t.grouped }}>
      <View style={styles.hero}>
        <Symbol ios="checkmark.circle.fill" android="check_circle" size={56} color={t.success} />
        <Text style={[type.title2, styles.text, { color: t.label }]}>{shown}</Text>
        <Text style={[type.subhead, styles.text, { color: t.secondary }]}>{`${tilde(ready.path)} on ${ready.machine}`}</Text>
      </View>
      {ready.facts.length === 0 ? null : (
        <ListSection footer={ready.leadLine}>
          {ready.facts.map(([k, v]) => (
            <ListRow key={k} title={k} detail={v} />
          ))}
        </ListSection>
      )}
      {ready.facts.length === 0 ? <Note>{ready.leadLine}</Note> : null}
      {ready.notes.length === 0 ? null : <Note>{ready.notes.join(" ")}</Note>}
      <View style={styles.open}>
        <Button label="Open Chat" size="large" onPress={onOpen} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, paddingHorizontal: space.xxl },
  text: { textAlign: "center" },
  track: { alignSelf: "stretch", height: 6, borderRadius: 3, overflow: "hidden" },
  bar: { height: 6, borderRadius: 3 },
  actions: { alignSelf: "stretch", gap: space.sm, marginTop: space.md },
  reading: { paddingVertical: space.xl },
  hero: { alignItems: "center", gap: space.sm, paddingTop: space.xl, paddingHorizontal: space.xl },
  open: { marginHorizontal: space.lg, marginTop: space.xl },
});
