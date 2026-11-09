// `import text from "x.rs" with { type: "text" }`: Bun reads the Rust source as text, and `bun build --compile`
// embeds it; the same for the contracts' McpTools.json, read as text and parsed on first use.
declare module "*.rs" {
  const text: string;
  export default text;
}
declare module "*/McpTools.json" {
  const text: string;
  export default text;
}
declare module "*/LeadCall.json" {
  const text: string;
  export default text;
}
