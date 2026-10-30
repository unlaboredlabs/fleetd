// The colours a bot icon comes in: a field (the round ground) and a mark (the shape on it). Every field sits in the
// middle tones or carries a mark that contrasts with it, so an icon reads on the desktop's and phone's light and dark
// grounds alike. Fleet is the app's own accent fill (desktop tokens.css --accent-fill, phone theme.ts accentFill);
// Teal, Plum and Sand lean on the agent role tints beside it.
export const PALETTE = [
  { id: "fleet", name: "Fleet", field: "#2E69CC", mark: "#E4EDFD" },
  { id: "sky", name: "Sky", field: "#8CC2F5", mark: "#0F3460" },
  { id: "teal", name: "Teal", field: "#17796E", mark: "#DDF6F0" },
  { id: "mint", name: "Mint", field: "#9ADDBD", mark: "#0D4A33" },
  { id: "lime", name: "Lime", field: "#CBE65A", mark: "#2F3B08" },
  { id: "sun", name: "Sun", field: "#F4B63F", mark: "#4A2A00" },
  { id: "ember", name: "Ember", field: "#E0602E", mark: "#FFF0E6" },
  { id: "rose", name: "Rose", field: "#EE8DB0", mark: "#561031" },
  { id: "plum", name: "Plum", field: "#6A4BC4", mark: "#EEE8FF" },
  { id: "lilac", name: "Lilac", field: "#C4B4F7", mark: "#2E1D6E" },
  { id: "sand", name: "Sand", field: "#D9C7A3", mark: "#46381F" },
  { id: "graphite", name: "Graphite", field: "#3E3E3B", mark: "#F2F1EC" },
];
