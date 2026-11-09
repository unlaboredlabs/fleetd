// `import text from "x.md" with { type: "text" }`: Bun reads the file as text, and `bun build --compile` embeds it.
declare module "*.md" {
  const text: string;
  export default text;
}
