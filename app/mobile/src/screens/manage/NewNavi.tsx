// New Navi, a sheet from the Chats list's +: what to call it and, with more than one machine it could live on, which
// (as the desktop's Navi screen: machine_roles' online machines that operate, a missing sandbox said and not picked).
// Its ✓ makes it (navi_create) and opens its chat.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useState } from "react";
import { ScrollView } from "react-native";
import { canHost, firstHome, NAME_MAX, nameProblem, naviHomes as homesOf, type HubError } from "../../desktop";
import { useHub, type RootParams } from "../../hubContext";
import { keyOf } from "../../store";
import { space, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListSection } from "../../ui/List";
import { createNavi, naviHomes } from "./api";
import { CheckRow, errorWords, FieldRow, Problem, sheetOptions, useRead } from "./parts";
import { closeThenOpen } from "./arrival";

/** What a new Navi is called when the name is left empty, as on the desktop. */
export const DEFAULT_NAME = "Navi";

export function NewNavi({ navigation, route }: NativeStackScreenProps<RootParams, "NewNavi">) {
  const t = useTheme();
  const { session } = useHub();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const roles = useRead(() => naviHomes(session), [session]);
  const homes = homesOf(roles.value?.machines ?? []);
  const choose = homes.length > 1;
  const machineId = !choose ? undefined : homes.some((m) => m.machineId === picked && canHost(m)) ? (picked ?? undefined) : firstHome(homes, roles.value?.best);
  const problem = nameProblem(name);

  const create = async () => {
    if (busy || problem !== undefined) return;
    setBusy(true);
    setError(null);
    const r = await createNavi(session, name.trim() === "" ? DEFAULT_NAME : name.trim(), machineId);
    if (!r.ok) {
      setBusy(false);
      setError(r.error);
      haptics.warning();
      return;
    }
    haptics.success();
    if (route.params?.back === true) return navigation.goBack();
    closeThenOpen(navigation, keyOf(r.value));
  };

  useLayoutEffect(() => {
    navigation.setOptions(sheetOptions(t, () => navigation.goBack(), { label: "Create", enabled: problem === undefined, busy, onPress: () => void create() }, !busy));
    // `create` reads what these are.
  }, [navigation, t, busy, problem, name, machineId]);
  // A machine picked that went offline falls back to the hub's pick, as on the desktop.
  useEffect(() => {
    if (picked !== null && !homes.some((m) => m.machineId === picked)) setPicked(null);
  }, [picked, homes]);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: space.xxl }} style={{ backgroundColor: t.grouped }}>
      <ListSection footer="A personal assistant with its own chat, memory, folder and approvals. It asks you before it sends anything.">
        <FieldRow
          value={name}
          onChangeText={setName}
          placeholder={DEFAULT_NAME}
          autoFocus
          maxLength={NAME_MAX + 1}
          autoCapitalize="words"
          returnKeyType="done"
          editable={!busy}
          invalid={problem !== undefined}
          onSubmitEditing={() => void create()}
          accessibilityLabel="Name"
        />
      </ListSection>
      <Problem text={problem} />
      {choose ? (
        <ListSection header="Lives on" footer="Its folder, memory and browser stay on this machine.">
          {homes.map((m) => (
            <CheckRow
              key={m.machineId}
              title={m.name}
              detail={m.naviSandbox === undefined ? undefined : m.naviSandbox.status === "ready" || m.naviSandbox.fix === undefined ? m.naviSandbox.line : `${m.naviSandbox.line} ${m.naviSandbox.fix}`}
              checked={m.machineId === machineId}
              disabled={busy || !canHost(m)}
              onPress={() => {
                haptics.select();
                setPicked(m.machineId);
              }}
            />
          ))}
        </ListSection>
      ) : null}
      <Problem text={error === null ? undefined : errorWords(error)} />
    </ScrollView>
  );
}
