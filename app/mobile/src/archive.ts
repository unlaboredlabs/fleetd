// Archive from a chat's hold menu, as the desktop's sidebar does: at once, with a quiet line over the list that says so
// and takes it back (Undo). Archived, a bot keeps its chat, memory and folder, and is under Archived; Delete is only
// on its Info page. Pure, so it is unit-tested.

/** The hold menu's word for a bot, and the lines said once it is done or refused. */
export const archiveWords = (title: string, archived: boolean) => ({
  /** What the menu offers: to archive it, or to bring it back when it is archived already. */
  label: archived ? "Unarchive" : "Archive",
  /** After archiving: the line over the list, with Undo beside it. */
  done: archived ? `${title} is back` : `${title} archived`,
  failed: archived ? `Couldn't bring back ${title}` : `Couldn't archive ${title}`,
});

/** How long the archived line, and its Undo, stay over the list. */
export const UNDO_MS = 6000;
