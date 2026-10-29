// After a Navi or a project is made: the sheet closes at once, before the hub's project.added brings it to the chats
// list (whose rows slide with a LayoutAnimation, which must not land in the same commit as the sheet's removal), and
// its chat opens once the sheet has slid away: dismissing a sheet and pushing a screen in one step crashes UIKit.
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Keyboard } from "react-native";
import type { RootParams } from "../../hubContext";
import type { Key } from "../../store";

type Sheet = NativeStackNavigationProp<RootParams, "NewNavi" | "NewProject">;

/** A sheet's slide down, after which a screen can be pushed: a sheet that goes gets no transitionEnd of its own. */
export const SHEET_GONE_MS = 600;

/** Closes the sheet, then opens `key`'s chat. */
export const closeThenOpen = (navigation: Sheet, key: Key): void => {
  Keyboard.dismiss();
  navigation.goBack();
  setTimeout(() => navigation.navigate("Chat", { key }), SHEET_GONE_MS);
};
