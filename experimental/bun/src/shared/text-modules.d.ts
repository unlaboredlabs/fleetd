// `import sql from "x.sql" with { type: "text" }`: Bun reads the file as text, and `bun build --compile` embeds it.
declare module "*.sql" {
  const text: string;
  export default text;
}
