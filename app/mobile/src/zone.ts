// The device's IANA time zone, which chat_send carries: the hub keeps it as the person's, so their projects read each
// message with the time where they are and schedules a reminder in it. Nothing when the engine can't say.
export const deviceZone = (): { tz?: string } => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz ? { tz } : {};
  } catch {
    return {};
  }
};
