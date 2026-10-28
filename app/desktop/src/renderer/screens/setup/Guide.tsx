// A setup step's guide, shared by #/setup and Administration's pages (Google): numbered parts, each with the provider's
// pages to open and the values to paste there, each value with a Copy button.
import { Copy, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Text, copyText, toast } from "../../ui";
import s from "./setup.module.css";

/** A value for the provider's form, computed for this hub. `note` is how to paste it. */
export interface PasteValue {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  /** Words, not a value: what to pick, tick or leave alone. */
  readonly plain?: boolean;
  /** Filled in by fleetd (a manifest, a link), shown to read and never copied. */
  readonly filled?: boolean;
}

/** A provider's page, opened in the browser. */
export interface Link {
  readonly label: string;
  readonly url: string;
}

/** One numbered part of a step: what to open, then what to fill in there. */
export interface GuidePart {
  readonly title: string;
  /** A part the step works without: said beside its title, and its fields are optional. */
  readonly optional?: boolean;
  readonly note?: string;
  readonly links?: ReadonlyArray<Link>;
  readonly values?: ReadonlyArray<PasteValue>;
}

/** The parts in order, numbered from `from`. */
export function GuideParts({ parts, from = 1 }: { parts: ReadonlyArray<GuidePart>; from?: number }) {
  return (
    <>
      {parts.map((part, i) => (
        <Part key={part.title} n={from + i} title={part.title} optional={part.optional === true}>
          {part.note === undefined ? null : (
            <Text as="p" size="sm" tone="quiet">
              {part.note}
            </Text>
          )}
          {part.links === undefined ? null : (
            <div className={s.links}>
              {part.links.map((link) => (
                <Button key={link.url} icon={<ExternalLink size={14} />} onClick={() => void window.fleetd.openExternal(link.url)}>
                  {link.label}
                </Button>
              ))}
            </div>
          )}
          {part.values === undefined ? null : <Values values={part.values} />}
        </Part>
      ))}
    </>
  );
}

/** A provider form's values: each to copy, or words to follow, or (filled) what fleetd fills in itself. */
export function Values({ values }: { values: ReadonlyArray<PasteValue> }) {
  return (
    <dl className={s.values}>
      {values.map((v) => (
        <div key={v.label} className={s.valueRow}>
          <dt>
            <Text size="sm" tone="quiet">
              {v.label}
            </Text>
          </dt>
          <dd>
            {v.plain === true ? (
              <Text size="sm">{v.value}</Text>
            ) : v.filled === true ? (
              <Text size="sm" mono className={s.value} data-text="code">
                {v.value}
              </Text>
            ) : (
              <span className={s.copyable}>
                <Text size="sm" mono preserveLines className={s.value} data-text="code">
                  {v.value}
                </Text>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label={`Copy ${v.label}`}
                  icon={<Copy size={14} />}
                  onClick={() => {
                    void copyText(v.value);
                    toast({ title: `${v.label} copied` });
                  }}
                />
              </span>
            )}
            {v.note === undefined ? null : (
              <Text as="p" size="xs" tone="quiet">
                {v.note}
              </Text>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Part({ n, title, optional = false, children }: { n: number; title: string; optional?: boolean; children: ReactNode }) {
  return (
    <section className={s.part}>
      <Text as="h3" size="sm" strong className={s.partHead}>
        <span className={s.partNumber}>{n}</span>
        {title}
        {optional ? (
          <Text size="xs" tone="faint">
            Optional
          </Text>
        ) : null}
      </Text>
      <div className={s.partBody}>{children}</div>
    </section>
  );
}

