// Lists that change as UIKit's do: a row that goes, comes or moves slides there, rather than jump.
import { useRef } from "react";
import { LayoutAnimation } from "react-native";

const SLIDE = LayoutAnimation.create(250, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity);

/** Animates the layout that follows a change of `shape` (the rows' keys, joined): set while rendering, before it lands. */
export const useAnimatedRows = (shape: string): void => {
  const last = useRef(shape);
  if (last.current === shape) return;
  last.current = shape;
  LayoutAnimation.configureNext(SLIDE);
};
