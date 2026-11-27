// Where the iPhone Duo's fold runs down the app's window, as iOS says (modules/hinge): src/split.ts puts the list on
// one side of it and the chat on the other. Undefined off a foldable, folded shut, or where nothing divides the window.
import { requireOptionalNativeModule } from "expo";
import { useEffect, useState } from "react";
import { Platform } from "react-native";
import type { Fold } from "./split";

interface HingeModule {
  fold(): Promise<Fold | null>;
  addListener(event: "onFold", listener: (e: { fold: Fold | null }) => void): { remove(): void };
}

const native = Platform.OS === "ios" ? requireOptionalNativeModule<HingeModule>("FleetdHinge") : null;

/** The fold as it is now, followed as the pose, the window or the hinge changes. */
export const useFold = (): Fold | undefined => {
  const [fold, setFold] = useState<Fold>();
  useEffect(() => {
    if (native === null) return;
    let live = true;
    // The same fold again keeps the one held: the panes don't lay out again for nothing.
    const take = (f: Fold | null) => setFold((was) => (f === null ? undefined : was !== undefined && was.x === f.x && was.width === f.width ? was : f));
    const sub = native.addListener("onFold", (e) => take(e.fold));
    void native.fold().then((f) => live && take(f));
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return fold;
};
