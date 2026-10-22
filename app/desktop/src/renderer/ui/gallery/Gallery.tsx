import { Archive, ArrowUp, Bell, Copy, FolderPlus, MessageSquare, PanelLeft, Plus, Settings, Square } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  AppFrame,
  Breadcrumb,
  Button,
  Checkbox,
  Code,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DataTable,
  Dialog,
  DiffView,
  Dot,
  EmptyState,
  Field,
  IdChip,
  Input,
  Kbd,
  Markdown,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Panel,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Radio,
  RadioGroup,
  RoleTag,
  SectionHeader,
  Select,
  Sheet,
  Sidebar,
  SidebarItem,
  SidebarSection,
  StatusChip,
  Strip,
  StripItem,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textarea,
  THEME_MODES,
  toast,
  Tooltip,
  TopBar,
  FrameTitle,
  Truncate,
  useTheme,
  VirtualList,
  isThemeMode,
  type AgentRole,
  type StatusTone,
} from "..";
import { CODE_LONG_LINE, CODE_TS, LOG_LINES, LONG, MARKDOWN, ORDER_ID, PATCH, PROMPTS, SHORT, UNBROKEN } from "./samples";
import s from "./gallery.module.css";

const SECTIONS = [
  ["tokens", "Tokens"],
  ["text", "Text"],
  ["buttons", "Buttons"],
  ["fields", "Fields"],
  ["choices", "Choices"],
  ["overlays", "Menus and dialogs"],
  ["tabs", "Tabs"],
  ["status", "Status"],
  ["markdown", "Markdown"],
  ["code", "Code"],
  ["diff", "Diff"],
  ["table", "Table"],
  ["list", "Long list"],
  ["layout", "Layout"],
] as const;

type SectionId = (typeof SECTIONS)[number][0];

/** The hash query: #/gallery?theme=dark&section=text. */
function readQuery(): { theme: string | null; section: string | null } {
  const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  return { theme: q.get("theme"), section: q.get("section") };
}

function useHashQuery() {
  const [query, setQuery] = useState(readQuery);
  useEffect(() => {
    const onHash = () => setQuery(readQuery());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return query;
}

/**
 * Every design-system component with short, long and empty content. Dev builds only (or VITE_FLEETD_GALLERY=1);
 * E3 screenshots it per section and theme: #/gallery?theme=light|dark&section=<id>.
 */
export default function Gallery() {
  const { mode, setMode } = useTheme();
  const query = useHashQuery();

  useEffect(() => {
    if (isThemeMode(query.theme)) setMode(query.theme);
  }, [query.theme, setMode]);

  const only = SECTIONS.find(([id]) => id === query.section)?.[0];
  const show = (id: SectionId) => !only || only === id;
  const link = (section?: string) => `#/gallery?${new URLSearchParams({ ...(query.theme ? { theme: query.theme } : {}), ...(section ? { section } : {}) }).toString()}`;

  return (
    <div className={s.page} data-screen={only ? `gallery.${only}` : "gallery"}>
      <header className={s.head}>
        <div className={s.headTitle}>
          <Text as="h1" strong>
            Design system
          </Text>
        </div>
        <Select
          aria-label="Appearance"
          value={mode}
          onValueChange={setMode}
          options={THEME_MODES.map((m) => ({ value: m.value, label: m.label }))}
          className={s.narrow}
        />
      </header>
      <nav className={s.nav} aria-label="Sections">
        <a href={link()} {...(!only ? { "aria-current": "page" as const } : {})}>
          All
        </a>
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={link(id)} {...(only === id ? { "aria-current": "page" as const } : {})}>
            {label}
          </a>
        ))}
      </nav>
      <div className={s.body}>
        {show("tokens") && <TokensSection />}
        {show("text") && <TextSection />}
        {show("buttons") && <ButtonsSection />}
        {show("fields") && <FieldsSection />}
        {show("choices") && <ChoicesSection />}
        {show("overlays") && <OverlaysSection />}
        {show("tabs") && <TabsSection />}
        {show("status") && <StatusSection />}
        {show("markdown") && <MarkdownSection />}
        {show("code") && <CodeSection />}
        {show("diff") && <DiffSection />}
        {show("table") && <TableSection />}
        {show("list") && <ListSection />}
        {show("layout") && <LayoutSection />}
      </div>
    </div>
  );
}

function Section({ id, title, children }: { id: SectionId; title: string; children: ReactNode }) {
  return (
    <section className={s.section} id={id} data-gallery-section={id}>
      <div className={s.sectionTitle}>
        <Text as="h2" size="lg" strong>
          {title}
        </Text>
      </div>
      {children}
    </section>
  );
}

function Case({ label, children, narrow }: { label: string; children: ReactNode; narrow?: boolean }) {
  return (
    <div className={s.case}>
      <Text size="xs" tone="quiet">
        {label}
      </Text>
      <div className={narrow ? s.narrow : undefined}>{children}</div>
    </div>
  );
}

const COLORS: ReadonlyArray<[string, string]> = [
  ["Content", "--bg"],
  ["Sidebar", "--sidebar"],
  ["Raised", "--raised"],
  ["Hairline", "--hairline"],
  ["Border", "--border"],
  ["Text", "--text"],
  ["Quiet text", "--quiet"],
  ["Faint", "--faint"],
  ["Accent", "--accent"],
  ["Primary fill", "--accent-fill"],
  ["Success", "--success"],
  ["Warning, needs you", "--warning"],
  ["Danger", "--danger"],
  ["Added line", "--diff-add"],
  ["Removed line", "--diff-del"],
  ["Implementer", "--role-implementer"],
  ["Reviewer", "--role-reviewer"],
  ["Verifier", "--role-verifier"],
  ["Lead", "--role-lead"],
];

function TokensSection() {
  return (
    <Section id="tokens" title="Tokens">
      <div className={s.grid}>
        {COLORS.map(([label, v]) => (
          <div key={v} className={s.swatch}>
            <span className={s.chipBox} style={{ background: `var(${v})` }} />
            <Text>{label}</Text>
          </div>
        ))}
      </div>
      <div className={s.case}>
        <Text size="display" strong tabular>
          68%
        </Text>
        <Text size="xl" strong>
          What should the fleet do?
        </Text>
        <Text size="lg" strong>
          {SHORT}
        </Text>
        <Text strong>A title is body size, set in semibold</Text>
        <Text>Body text: criteria, questions, messages and descriptions.</Text>
        <Text size="xs" tone="quiet">
          Metadata: 3 agents · 12 min · buildbox
        </Text>
        <Text mono>fleetd order --project acme/storefront</Text>
      </div>
    </Section>
  );
}

function TextSection() {
  return (
    <Section id="text" title="Text">
      <div className={s.cols3}>
        <Case label="Wraps, short">
          <Text as="p">{SHORT}</Text>
        </Case>
        <Case label="Wraps, long">
          <Text as="p">{LONG}</Text>
        </Case>
        <Case label="Wraps, one unbroken path">
          <Text as="p" mono>
            {UNBROKEN}
          </Text>
        </Case>
        <Case label="Truncates, fits">
          <Truncate>{SHORT}</Truncate>
        </Case>
        <Case label="Truncates, cut: hover for all of it, click to copy">
          <Truncate>{LONG}</Truncate>
        </Case>
        <Case label="Two lines, then cut">
          <Truncate lines={2}>{LONG}</Truncate>
        </Case>
        <Case label="Unfolds in place on click">
          <Truncate expand="inline">{LONG}</Truncate>
        </Case>
        <Case label="Truncates, empty">
          <Truncate>{""}</Truncate>
        </Case>
        <Case label="A label with its id behind copy">
          <IdChip label={LONG} id={ORDER_ID} kind="order" />
        </Case>
      </div>
    </Section>
  );
}

function ButtonsSection() {
  return (
    <Section id="buttons" title="Buttons">
      {([false, true] as const).map((disabled) => (
        <div key={String(disabled)} className={s.row}>
          <Button variant="primary" disabled={disabled} shortcut="⌘↵">
            Send
          </Button>
          <Button variant="secondary" disabled={disabled}>
            Cancel
          </Button>
          <Button variant="ghost" disabled={disabled} icon={<Plus />}>
            New order
          </Button>
          <Button variant="quiet" disabled={disabled}>
            Not now
          </Button>
          <Button variant="danger" disabled={disabled}>
            Stop the order
          </Button>
          <Button variant="quiet" iconOnly aria-label="Copy" disabled={disabled}>
            <Copy />
          </Button>
          <Button variant="primary" iconOnly round aria-label="Send" disabled={disabled}>
            <ArrowUp />
          </Button>
          <Button variant="link" disabled={disabled}>
            Show
          </Button>
          <Text size="xs" tone="quiet">
            {disabled ? "disabled" : "enabled"}
          </Text>
        </div>
      ))}
      <div className={s.row}>
        <Button variant="primary" size="md">
          Add project
        </Button>
        <Button size="md">Choose folder</Button>
        <div className={s.narrow}>
          <Button title={LONG}>{LONG}</Button>
        </div>
        <Kbd>⌘K</Kbd>
      </div>
    </Section>
  );
}

function FieldsSection() {
  const [text, setText] = useState(LONG);
  const [value, setValue] = useState<"devbox" | "buildbox" | undefined>(undefined);
  return (
    <Section id="fields" title="Fields">
      <div className={s.cols3}>
        <Field label="Project name" description="What the sidebar and the board call it.">
          <Input placeholder="storefront" />
        </Field>
        <Field label="Folder" description="A long value scrolls inside the field.">
          <Input mono defaultValue={UNBROKEN} />
        </Field>
        <Field label="Hub address" error="That address didn't answer. Check that the hub is running on your console, then try again.">
          <Input defaultValue="buildbox:4711" />
        </Field>
        <Field label="Disabled">
          <Input disabled defaultValue="Set by the hub" />
        </Field>
        <Field label="Machine">
          <Select
            value={value}
            onValueChange={setValue}
            placeholder="Choose a machine"
            options={[
              { value: "devbox", label: "devbox" },
              { value: "buildbox", label: "buildbox, the one with the GPU and the long name" },
            ]}
          />
        </Field>
        <Field label="Select, disabled">
          <Select value={undefined} onValueChange={() => undefined} disabled placeholder="No machines yet" options={[]} />
        </Field>
      </div>
      <Field label="Instructions" description="Grows with what you type, up to 8 lines, then scrolls.">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} maxRows={8} />
      </Field>
      <Field label="Empty textarea">
        <Textarea placeholder="Tell the lead what to do…" />
      </Field>
    </Section>
  );
}

function ChoicesSection() {
  return (
    <Section id="choices" title="Choices">
      <div className={s.cols3}>
        <div className={s.case}>
          <Checkbox label="Notify me when a lead is waiting for my reply" defaultChecked />
          <Checkbox label="Open the last chat on launch" />
          <Checkbox label={LONG} description="A long label wraps beside the box." />
          <Checkbox label="Disabled and on" disabled checked />
          <Checkbox label="Some of the projects" checked="indeterminate" />
        </div>
        <div className={s.case}>
          <Switch label="Launch at login" defaultChecked />
          <Switch label="Show machine load" description="In the strip under the chat." />
          <Switch label="Disabled" disabled />
        </div>
        <RadioGroup defaultValue="system" aria-label="Appearance">
          <Radio value="system" label="Match system" />
          <Radio value="light" label="Light" />
          <Radio value="dark" label="Dark" description="Easier at night." />
          <Radio value="off" label="Disabled" disabled />
        </RadioGroup>
      </div>
    </Section>
  );
}

function OverlaysSection() {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(true);
  return (
    <Section id="overlays" title="Menus and dialogs">
      <div className={s.row}>
        <Menu>
          <MenuTrigger asChild>
            <Button>Order menu</Button>
          </MenuTrigger>
          <MenuContent>
            <MenuLabel>Order</MenuLabel>
            <MenuItem icon={<MessageSquare />} hint="⌘L">
              Open the project chat
            </MenuItem>
            <MenuItem icon={<Copy />}>Copy order link</MenuItem>
            <MenuItem>{LONG}</MenuItem>
            <MenuCheckboxItem checked={showAll} onCheckedChange={setShowAll}>
              Show finished lanes
            </MenuCheckboxItem>
            <MenuItem disabled>Retry (nothing failed)</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Square />} danger hint="⌘.">
              Stop the order
            </MenuItem>
          </MenuContent>
        </Menu>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className={s.box}>
              <Text tone="quiet">Right-click here</Text>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem icon={<Copy />}>Copy</ContextMenuItem>
            <ContextMenuItem icon={<Archive />}>Archive</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem danger>Remove</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <Dialog
          trigger={<Button>Confirm dialog</Button>}
          title="Stop this order?"
          description={`The lead and its 3 agents stop now. ${LONG}`}
          footer={
            <>
              <Button>Keep going</Button>
              <Button variant="danger">Stop the order</Button>
            </>
          }
        />
        <Sheet
          open={open}
          onOpenChange={setOpen}
          trigger={<Button icon={<FolderPlus />}>Add project sheet</Button>}
          title="Add a project"
          description="Pick a folder on one of your machines."
          footer={
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary">Add project</Button>
            </>
          }
        >
          <Field label="Folder">
            <Input mono placeholder="~/src/storefront" />
          </Field>
        </Sheet>
        <Popover>
          <PopoverTrigger asChild>
            <Button>Popover</Button>
          </PopoverTrigger>
          <PopoverContent>
            <Text as="p">{LONG}</Text>
          </PopoverContent>
        </Popover>
        <Tooltip content="Notifications">
          <Button variant="quiet" iconOnly aria-label="Notifications">
            <Bell />
          </Button>
        </Tooltip>
        <Tooltip content={LONG}>
          <Button>Long tooltip</Button>
        </Tooltip>
        <Button onClick={() => toast({ title: "Order sent", description: "The lead picks it up on its next wake.", tone: "success" })}>Toast</Button>
        <Button
          onClick={() =>
            toast({ title: "Couldn't reach buildbox", description: LONG, tone: "danger", action: { label: "Retry", onClick: () => undefined } })
          }
        >
          Long toast
        </Button>
      </div>
    </Section>
  );
}

function TabsSection() {
  return (
    <Section id="tabs" title="Tabs">
      <Tabs defaultValue="general">
        <TabList aria-label="Settings">
          <Tab value="general">General</Tab>
          <Tab value="prompts" count={62}>
            Prompts
          </Tab>
          <Tab value="instructions">Instructions</Tab>
          <Tab value="soon" disabled>
            Later
          </Tab>
        </TabList>
        <TabPanel value="general">
          <Text as="p" tone="quiet">
            General settings.
          </Text>
        </TabPanel>
        <TabPanel value="prompts">
          <Text as="p">{LONG}</Text>
        </TabPanel>
        <TabPanel value="instructions">
          <Text as="p" tone="quiet">
            Nothing written yet.
          </Text>
        </TabPanel>
      </Tabs>
    </Section>
  );
}

const TONES: ReadonlyArray<[StatusTone, string]> = [
  ["needs-you", "needs you · waiting for your reply"],
  ["failed", "failed: tests"],
  ["working", "3 working"],
  ["quiet", "queued"],
  ["idle", "waiting for the lead"],
  ["done", "done"],
];
const ROLES: ReadonlyArray<AgentRole> = ["lead", "implementer", "reader", "reviewer", "verifier", "qa"];

function StatusSection() {
  return (
    <Section id="status" title="Status">
      <div className={s.row}>
        {TONES.map(([tone, label]) => (
          <StatusChip key={tone} tone={tone}>
            {label}
          </StatusChip>
        ))}
      </div>
      <div className={s.row}>
        {ROLES.map((r) => (
          <RoleTag key={r} role={r} />
        ))}
      </div>
      <div className={s.narrow}>
        <StatusChip tone="needs-you">{`needs you · ${LONG}`}</StatusChip>
      </div>
      <div className={s.row}>
        <Dot color="var(--success)" label="online" />
        <Text size="xs" tone="quiet">
          buildbox
        </Text>
      </div>
    </Section>
  );
}

function MarkdownSection() {
  return (
    <Section id="markdown" title="Markdown">
      <div className={s.cols3} style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
        <Case label="A message">
          <Markdown source={MARKDOWN} />
        </Case>
        <div className={s.case}>
          <Case label="With a raw switch (exactly as sent)">
            <Markdown source={"Run the **checkout** tests on `buildbox`, then:\n\n- open the PR\n- ask before merging"} rawToggle />
          </Case>
          <Case label="Starts raw">
            <Markdown source={"## Done when\n\n- the flag is on\n- refunds reconcile"} rawToggle initialRaw />
          </Case>
          <Case label="Raw HTML is dropped">
            <Markdown source={"Before <b>bold</b> <script>alert(1)</script> after."} />
          </Case>
          <Case label="Empty">
            <Markdown source="" />
          </Case>
        </div>
      </div>
    </Section>
  );
}

function CodeSection() {
  return (
    <Section id="code" title="Code">
      <Code code={CODE_TS} lang="ts" title="charge.test.ts" />
      <Code code={CODE_LONG_LINE} lang="sh" />
      <Code code={CODE_LONG_LINE} lang="sh" wrap={false} title="Not wrapped: scrolls sideways" />
      <Code code={"plain text with no language"} />
    </Section>
  );
}

function DiffSection() {
  return (
    <Section id="diff" title="Diff">
      <DiffView patch={PATCH} />
      <Case label="Side by side">
        <DiffView patch={PATCH} mode="split" bare />
      </Case>
      <Case label="Not a diff">
        <DiffView patch="Nothing here parses as a patch." />
      </Case>
      <Case label="Empty">
        <DiffView patch="" />
      </Case>
    </Section>
  );
}

function TableSection() {
  const [selected, setSelected] = useState<string | null>("p2");
  return (
    <Section id="table" title="Table">
      <DataTable
        aria-label="Prompts"
        rows={PROMPTS}
        getKey={(p) => p.id}
        selectedKey={selected}
        onRowClick={(p) => setSelected(p.id)}
        columns={[
          { key: "name", header: "Prompt", width: "minmax(0, 1fr)", text: (p) => p.name, mode: "truncate", style: { strong: true } },
          { key: "desc", header: "What it's for", width: "minmax(0, 2fr)", text: (p) => p.description || "No description yet.", style: { tone: "quiet" } },
          { key: "machine", header: "Machine", width: "96px", text: (p) => p.machine, mode: "truncate" },
          { key: "updated", header: "Changed", width: "88px", align: "end", text: (p) => p.updated, mode: "truncate", style: { size: "xs", tone: "quiet" } },
        ]}
      />
      <DataTable aria-label="Empty table" rows={[]} getKey={(p: (typeof PROMPTS)[number]) => p.id} columns={[{ key: "name", header: "Prompt", text: (p) => p.name }]} empty="No prompts match that search." />
    </Section>
  );
}

function ListSection() {
  return (
    <Section id="list" title="Long list">
      <Text size="xs" tone="quiet">
        2,000 rows of mixed height; only the visible ones render.
      </Text>
      <div className={s.listBox}>
        <VirtualList
          aria-label="Log"
          items={LOG_LINES}
          getKey={(_, i) => i}
          estimateSize={23}
          renderItem={(line) => (
            <div className={s.logRow}>
              <Text mono size="sm">
                {line}
              </Text>
            </div>
          )}
        />
      </div>
    </Section>
  );
}

function LayoutSection() {
  return (
    <Section id="layout" title="Layout">
      <div className={s.frameBox}>
        <AppFrame
          topBar={
            <TopBar
              trailing={
                <>
                  <Button variant="quiet" iconOnly aria-label="Settings">
                    <Settings />
                  </Button>
                </>
              }
            />
          }
          sidebarTop={
            <Button variant="quiet" iconOnly aria-label="Hide the sidebar">
              <PanelLeft />
            </Button>
          }
          sidebar={
            <Sidebar>
              <SidebarSection
                title="Projects"
                action={
                  <Button variant="quiet" iconOnly aria-label="Add project">
                    <Plus />
                  </Button>
                }
              >
                <SidebarItem label="storefront" current trailing={<Dot color="var(--warning)" label="needs you" />} />
                <SidebarItem label="docs site" trailing={<Dot color="var(--text)" label="running" />} />
                <SidebarItem label={LONG} />
                <SidebarItem label="archived project" disabled />
              </SidebarSection>
            </Sidebar>
          }
        >
          <FrameTitle>
            <Breadcrumb items={[{ label: "storefront", onClick: () => undefined }, { label: LONG }]} />
          </FrameTitle>
          <Panel
            fill
            header={
              <SectionHeader
                bordered
                title={LONG}
                count="3 agents"
                description="Started 12 min ago on buildbox"
                actions={
                  <>
                    <Button>Steer</Button>
                    <Button variant="danger">Stop</Button>
                  </>
                }
              />
            }
            padded
            measure
          >
            <Text as="p">{LONG}</Text>
          </Panel>
          <Strip label="Train" edge="top">
            <StripItem icon={<Dot color="var(--success)" />} label="#208 merged" />
            <StripItem icon={<Dot color="var(--text)" />} label="#211 in CI" value="2/3" />
            <StripItem icon={<Dot color="var(--warning)" />} label={`#212 ${LONG}`} />
            <StripItem label="buildbox load" value="0.42" />
          </Strip>
        </AppFrame>
      </div>
      <div className={s.box}>
        <EmptyState title="No orders yet" actions={<Button variant="primary">New order</Button>}>
          Type what the fleet should do and pick a project; the lead takes it from there.
        </EmptyState>
      </div>
      <div className={s.box}>
        <EmptyState title="Couldn't reach the hub" tone="danger" actions={<Button>Try again</Button>}>
          {LONG}
        </EmptyState>
      </div>
    </Section>
  );
}
