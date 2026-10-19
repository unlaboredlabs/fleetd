// Focus return for the palette and the shortcuts sheet. They have no Radix trigger, and a modal Radix dialog sends
// focus back only to its trigger, so without this a close leaves focus on <body>.

import { useState, type SyntheticEvent } from "react";

/**
 * Remembers what had focus when the overlay first rendered. Pass the result to Content's onCloseAutoFocus.
 * `keep()` true means a command moved focus on purpose (⌘L to the composer), so it stays there.
 */
export const useReturnFocus = (keep: () => boolean = () => false): ((event: Event | SyntheticEvent) => void) => {
  const [returnTo] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  return (event) => {
    event.preventDefault();
    if (!keep() && returnTo?.isConnected === true) returnTo.focus({ preventScroll: true });
  };
};
