// Add to a Project, a sheet from a set-aside variable in Settings › Vault: the hub's projects, one ticked, and Add, the
// sheet's ✓, which makes the variable that project's (vault_move). The hub refuses a project that has one of that name,
// and the sheet says so.
import { useLayoutEffect, useState } from "react";
import { ScrollView } from "react-native";
import { useHub } from "../../hubContext";
import { refOf } from "../../store";
import { space, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { CheckRow, errorWords, Problem, sheetOptions } from "../manage/parts";
import { moveItem, vaultErrorWords, vaultHub } from "./api";
import { moveTargets, titleOf } from "./model";
import { useVaultNav, useVaultRoute } from "./parts";

export function VaultMove() {
  const t = useTheme();
  const navigation = useVaultNav();
  const { item } = useVaultRoute<"VaultMove">().params;
  const { state, session } = useHub();
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const projects = moveTargets(state.projects);

  const run = async () => {
    if (busy || picked === undefined) return;
    setBusy(true);
    setProblem(undefined);
    const r = await moveItem(vaultHub(session), item.itemId, refOf(picked));
    setBusy(false);
    if (!r.ok) {
      haptics.warning();
      return setProblem(`Not added: ${vaultErrorWords(r.error) ?? errorWords(r.error)}`);
    }
    haptics.success();
    navigation.goBack();
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      title: titleOf(item),
      ...sheetOptions(t, () => navigation.goBack(), { label: "Add", enabled: picked !== undefined, busy, onPress: () => void run() }, !busy),
    });
    // `run` reads `picked`.
  }, [navigation, t, picked, busy, item]);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }} style={{ backgroundColor: t.grouped }}>
      {projects.length === 0 ? (
        <EmptyState icon="folder" title="No Projects" body="Add a project first, then add the variable to it." />
      ) : (
        <ListSection header="Add to" footer="Its agents get it when they start.">
          {projects.map((p) => (
            <CheckRow
              key={p.key}
              title={p.title}
              checked={picked === p.key}
              disabled={busy}
              onPress={() => {
                haptics.select();
                setPicked(p.key);
              }}
            />
          ))}
        </ListSection>
      )}
      <Problem text={problem} />
    </ScrollView>
  );
}
