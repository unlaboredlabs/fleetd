//! Validated building blocks that mirror Effect Schema's checks, so decoding refuses what older hubs refused.
//!
//! Lengths count UTF-16 code units, like JavaScript's `string.length`, which Effect's `isMaxLength` uses.

use std::borrow::Cow;
use std::fmt;
use std::ops::Deref;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// JavaScript's `Number.MAX_SAFE_INTEGER`, Effect's bound for `Schema.Int`.
pub const MAX_SAFE_INT: i64 = 9_007_199_254_740_991;

pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn has_line_break(s: &str) -> bool {
    s.contains(['\r', '\n'])
}

/// A string of `MIN..=MAX` UTF-16 units. `Text<1, { usize::MAX }>` is Effect's `NonEmptyString`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Text<const MIN: usize, const MAX: usize>(String);

/// [`Text`] that also refuses `\r` and `\n` (`/^[^\r\n]*$/`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Line<const MIN: usize, const MAX: usize>(String);

/// Effect's `Schema.NonEmptyString`.
pub type NonEmpty = Text<1, { usize::MAX }>;

macro_rules! string_wrapper {
    ($name:ident, $check:expr, $line:expr) => {
        impl<const MIN: usize, const MAX: usize> $name<MIN, MAX> {
            pub fn new(value: impl Into<String>) -> Result<Self, String> {
                let value = value.into();
                let len = js_len(&value);
                if len < MIN {
                    return Err(if MIN == 1 { "expected a non-empty string".into() } else { format!("expected at least {MIN} characters") });
                }
                if len > MAX {
                    return Err(format!("expected at most {MAX} characters"));
                }
                let check: fn(&str) -> bool = $check;
                if !check(&value) {
                    return Err("expected a single line".into());
                }
                Ok(Self(value))
            }
            /// For values the hub builds itself and has already bounded.
            pub fn unchecked(value: impl Into<String>) -> Self {
                Self(value.into())
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
            pub fn into_inner(self) -> String {
                self.0
            }
        }
        impl<const MIN: usize, const MAX: usize> Deref for $name<MIN, MAX> {
            type Target = str;
            fn deref(&self) -> &str {
                &self.0
            }
        }
        impl<const MIN: usize, const MAX: usize> AsRef<str> for $name<MIN, MAX> {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
        impl<const MIN: usize, const MAX: usize> fmt::Display for $name<MIN, MAX> {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
        impl<const MIN: usize, const MAX: usize> TryFrom<String> for $name<MIN, MAX> {
            type Error = String;
            fn try_from(value: String) -> Result<Self, String> {
                Self::new(value)
            }
        }
        impl<const MIN: usize, const MAX: usize> TryFrom<&str> for $name<MIN, MAX> {
            type Error = String;
            fn try_from(value: &str) -> Result<Self, String> {
                Self::new(value)
            }
        }
        impl<const MIN: usize, const MAX: usize> PartialEq<str> for $name<MIN, MAX> {
            fn eq(&self, other: &str) -> bool {
                self.0 == other
            }
        }
        impl<const MIN: usize, const MAX: usize> PartialEq<&str> for $name<MIN, MAX> {
            fn eq(&self, other: &&str) -> bool {
                self.0 == *other
            }
        }
        impl<const MIN: usize, const MAX: usize> Serialize for $name<MIN, MAX> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(&self.0)
            }
        }
        impl<'de, const MIN: usize, const MAX: usize> Deserialize<'de> for $name<MIN, MAX> {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                Self::new(String::deserialize(d)?).map_err(serde::de::Error::custom)
            }
        }
        impl<const MIN: usize, const MAX: usize> JsonSchema for $name<MIN, MAX> {
            fn inline_schema() -> bool {
                true
            }
            fn schema_name() -> Cow<'static, str> {
                format!("{}_{MIN}_{MAX}", stringify!($name)).into()
            }
            fn json_schema(_: &mut SchemaGenerator) -> Schema {
                let mut schema = json_schema!({ "type": "string" });
                if MIN > 0 {
                    schema.insert("minLength".into(), MIN.into());
                }
                if MAX < usize::MAX {
                    schema.insert("maxLength".into(), MAX.into());
                }
                if $line {
                    schema.insert("pattern".into(), "^[^\\r\\n]*$".into());
                }
                schema
            }
        }
    };
}

string_wrapper!(Text, |_| true, false);
string_wrapper!(Line, |s| !has_line_break(s), true);

/// An array of `MIN..=MAX` items; `UNIQUE` refuses duplicates (Effect's `isUnique`).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct List<T, const MIN: usize, const MAX: usize, const UNIQUE: bool = false>(Vec<T>);

/// Effect's `Schema.Array(...).check(isUnique())` with a max.
pub type UniqueList<T, const MIN: usize, const MAX: usize> = List<T, MIN, MAX, true>;

impl<T, const MIN: usize, const MAX: usize, const UNIQUE: bool> Default
    for List<T, MIN, MAX, UNIQUE>
{
    fn default() -> Self {
        Self(Vec::new())
    }
}

impl<T: PartialEq, const MIN: usize, const MAX: usize, const UNIQUE: bool>
    List<T, MIN, MAX, UNIQUE>
{
    pub fn new(items: Vec<T>) -> Result<Self, String> {
        if items.len() < MIN {
            return Err(format!("expected at least {MIN} items"));
        }
        if items.len() > MAX {
            return Err(format!("expected at most {MAX} items"));
        }
        if UNIQUE
            && items
                .iter()
                .enumerate()
                .any(|(i, item)| items[..i].contains(item))
        {
            return Err("expected unique items".into());
        }
        Ok(Self(items))
    }
}

impl<T, const MIN: usize, const MAX: usize, const UNIQUE: bool> List<T, MIN, MAX, UNIQUE> {
    /// For lists the hub builds itself and has already trimmed to `MAX`.
    pub fn unchecked(items: Vec<T>) -> Self {
        Self(items)
    }
    pub fn into_inner(self) -> Vec<T> {
        self.0
    }
}

impl<T, const MIN: usize, const MAX: usize, const UNIQUE: bool> Deref
    for List<T, MIN, MAX, UNIQUE>
{
    type Target = Vec<T>;
    fn deref(&self) -> &Vec<T> {
        &self.0
    }
}

impl<'a, T, const MIN: usize, const MAX: usize, const UNIQUE: bool> IntoIterator
    for &'a List<T, MIN, MAX, UNIQUE>
{
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}

impl<T, const MIN: usize, const MAX: usize, const UNIQUE: bool> IntoIterator
    for List<T, MIN, MAX, UNIQUE>
{
    type Item = T;
    type IntoIter = std::vec::IntoIter<T>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

impl<T: PartialEq, const MIN: usize, const MAX: usize, const UNIQUE: bool> TryFrom<Vec<T>>
    for List<T, MIN, MAX, UNIQUE>
{
    type Error = String;
    fn try_from(items: Vec<T>) -> Result<Self, String> {
        Self::new(items)
    }
}

impl<T: Serialize, const MIN: usize, const MAX: usize, const UNIQUE: bool> Serialize
    for List<T, MIN, MAX, UNIQUE>
{
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(s)
    }
}

impl<'de, T: Deserialize<'de> + PartialEq, const MIN: usize, const MAX: usize, const UNIQUE: bool>
    Deserialize<'de> for List<T, MIN, MAX, UNIQUE>
{
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::new(Vec::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}

impl<T: JsonSchema, const MIN: usize, const MAX: usize, const UNIQUE: bool> JsonSchema
    for List<T, MIN, MAX, UNIQUE>
{
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        format!("List_{}_{MIN}_{MAX}_{UNIQUE}", T::schema_name()).into()
    }
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = json_schema!({ "type": "array", "items": generator.subschema_for::<T>() });
        if MIN > 0 {
            schema.insert("minItems".into(), MIN.into());
        }
        if MAX < usize::MAX {
            schema.insert("maxItems".into(), MAX.into());
        }
        if UNIQUE {
            schema.insert("uniqueItems".into(), true.into());
        }
        schema
    }
}

/// An integer in `MIN..=MAX` (Effect's `Schema.Int` with bounds).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Int<const MIN: i64, const MAX: i64>(i64);

/// Effect's `Schema.Int.check(isGreaterThanOrEqualTo(0))`.
pub type Count = Int<0, MAX_SAFE_INT>;
/// Effect's `Schema.Int.check(isGreaterThanOrEqualTo(1))`.
pub type Positive = Int<1, MAX_SAFE_INT>;
/// Effect's plain `Schema.Int`.
pub type AnyInt = Int<{ -MAX_SAFE_INT }, MAX_SAFE_INT>;

impl<const MIN: i64, const MAX: i64> Int<MIN, MAX> {
    pub fn new(value: i64) -> Result<Self, String> {
        if value < MIN || value > MAX {
            return Err(format!("expected an integer between {MIN} and {MAX}"));
        }
        Ok(Self(value))
    }
    pub fn unchecked(value: i64) -> Self {
        Self(value)
    }
    pub fn get(self) -> i64 {
        self.0
    }
}

impl<const MIN: i64, const MAX: i64> Default for Int<MIN, MAX> {
    fn default() -> Self {
        Self(MIN.max(0).min(MAX))
    }
}

impl<const MIN: i64, const MAX: i64> fmt::Display for Int<MIN, MAX> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl<const MIN: i64, const MAX: i64> TryFrom<i64> for Int<MIN, MAX> {
    type Error = String;
    fn try_from(value: i64) -> Result<Self, String> {
        Self::new(value)
    }
}

impl<const MIN: i64, const MAX: i64> From<Int<MIN, MAX>> for i64 {
    fn from(value: Int<MIN, MAX>) -> i64 {
        value.0
    }
}

impl<const MIN: i64, const MAX: i64> Serialize for Int<MIN, MAX> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_i64(self.0)
    }
}

impl<'de, const MIN: i64, const MAX: i64> Deserialize<'de> for Int<MIN, MAX> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        // JSON from JavaScript writes 3 as `3`, but accept `3.0` too: Effect's Int only asks for an integral number.
        let number = serde_json::Number::deserialize(d)?;
        let value = number
            .as_i64()
            .or_else(|| {
                number
                    .as_f64()
                    .filter(|f| f.fract() == 0.0 && f.abs() <= MAX_SAFE_INT as f64)
                    .map(|f| f as i64)
            })
            .ok_or_else(|| serde::de::Error::custom("expected an integer"))?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

impl<const MIN: i64, const MAX: i64> JsonSchema for Int<MIN, MAX> {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        format!("Int_{MIN}_{MAX}").into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "integer", "minimum": MIN, "maximum": MAX })
    }
}

/// An `Int<MIN, MAX>` that decodes to `DEFAULT` when its key is absent (Effect's `withDecodingDefaultKey`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct IntOr<const MIN: i64, const MAX: i64, const DEFAULT: i64>(pub Int<MIN, MAX>);

impl<const MIN: i64, const MAX: i64, const DEFAULT: i64> IntOr<MIN, MAX, DEFAULT> {
    pub fn get(self) -> i64 {
        self.0.get()
    }
}

impl<const MIN: i64, const MAX: i64, const DEFAULT: i64> Default for IntOr<MIN, MAX, DEFAULT> {
    fn default() -> Self {
        Self(Int(DEFAULT))
    }
}

impl<const MIN: i64, const MAX: i64, const DEFAULT: i64> Serialize for IntOr<MIN, MAX, DEFAULT> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(s)
    }
}

impl<'de, const MIN: i64, const MAX: i64, const DEFAULT: i64> Deserialize<'de>
    for IntOr<MIN, MAX, DEFAULT>
{
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Int::deserialize(d).map(Self)
    }
}

impl<const MIN: i64, const MAX: i64, const DEFAULT: i64> JsonSchema for IntOr<MIN, MAX, DEFAULT> {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        format!("Int_{MIN}_{MAX}_or_{DEFAULT}").into()
    }
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        Int::<MIN, MAX>::json_schema(generator)
    }
}

macro_rules! float_wrapper {
    ($(#[$doc:meta])* $name:ident, $ok:expr, $err:literal, $schema:tt) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, Default, PartialEq, PartialOrd)]
        pub struct $name(f64);

        impl $name {
            pub fn new(value: f64) -> Result<Self, String> {
                let ok: fn(f64) -> bool = $ok;
                if value.is_finite() && ok(value) { Ok(Self(value)) } else { Err($err.into()) }
            }
            pub fn unchecked(value: f64) -> Self {
                Self(value)
            }
            pub fn get(self) -> f64 {
                self.0
            }
        }
        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                serialize_js_number(self.0, s)
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                Self::new(f64::deserialize(d)?).map_err(serde::de::Error::custom)
            }
        }
        impl JsonSchema for $name {
            fn inline_schema() -> bool {
                true
            }
            fn schema_name() -> Cow<'static, str> {
                stringify!($name).into()
            }
            fn json_schema(_: &mut SchemaGenerator) -> Schema {
                json_schema!($schema)
            }
        }
    };
}

float_wrapper!(
    /// Effect's `Schema.Finite`.
    Finite, |_| true, "expected a finite number", { "type": "number" }
);
float_wrapper!(
    /// `Schema.Finite.check(isGreaterThanOrEqualTo(0))`, e.g. minutes.
    NonNegative, |v| v >= 0.0, "expected a number of at least 0", { "type": "number", "minimum": 0 }
);
float_wrapper!(
    /// `Schema.Finite.check(isGreaterThan(0))`, e.g. a ratio.
    PositiveNumber, |v| v > 0.0, "expected a number greater than 0", { "type": "number", "exclusiveMinimum": 0 }
);

/// Writes integral floats as integers, like `JSON.stringify` (`3`, not `3.0`).
pub fn serialize_js_number<S: Serializer>(value: f64, s: S) -> Result<S::Ok, S::Error> {
    if value.fract() == 0.0 && value.abs() <= MAX_SAFE_INT as f64 {
        s.serialize_i64(value as i64)
    } else {
        s.serialize_f64(value)
    }
}

/// A JSON string literal: `Schema.Literal("*")`, `Schema.Literal("webhook")`, `Schema.Literal(true)` and so on.
#[macro_export]
macro_rules! literal {
    ($(#[$doc:meta])* $name:ident = $value:literal) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
        pub enum $name {
            #[default]
            #[serde(rename = $value)]
            Value,
        }
    };
}

/// `Schema.Literal(true)`, as `{ ok: true }` results carry it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct True;

impl Serialize for True {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bool(true)
    }
}

impl<'de> Deserialize<'de> for True {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        if bool::deserialize(d)? {
            Ok(True)
        } else {
            Err(serde::de::Error::custom("expected true"))
        }
    }
}

impl JsonSchema for True {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        "True".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "boolean", "enum": [true] })
    }
}

/// Schema-only stand-in for a required `Schema.NullOr(T)` field: use with `#[schemars(with = "NullOr<T>")]` on an
/// `Option<T>` field marked `#[serialize_always]`, so the schema keeps the key required and `null` allowed.
pub struct NullOr<T>(std::marker::PhantomData<T>);

impl<T: JsonSchema> JsonSchema for NullOr<T> {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        format!("NullOr_{}", T::schema_name()).into()
    }
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "anyOf": [generator.subschema_for::<T>(), { "type": "null" }] })
    }
}

/// A string brand: a newtype over `String`, validated on decode, with its own `$defs` entry when `name` is given.
///
/// ```ignore
/// brand!(
///     /// Docs.
///     WorkstreamId, name = "WorkstreamId", pattern = r"^W[1-9][0-9]*$"
/// );
/// brand!(SecretSink, name = "SecretSink", check = |s| parse_secret_sink(s).is_some(), expected = "...");
/// ```
#[macro_export]
macro_rules! brand {
    (@base $(#[$doc:meta])* $name:ident, $def:expr, $check:expr, $expected:expr, $pattern:expr, $description:expr) => {
        $(#[$doc])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, String> {
                let value = value.into();
                let check: fn(&str) -> bool = $check;
                if check(&value) { Ok(Self(value)) } else { Err(format!("expected {}, got {:?}", $expected, value)) }
            }
            /// For values the hub mints or has already validated.
            pub fn unchecked(value: impl Into<String>) -> Self {
                Self(value.into())
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
            pub fn into_inner(self) -> String {
                self.0
            }
        }
        impl std::ops::Deref for $name {
            type Target = str;
            fn deref(&self) -> &str {
                &self.0
            }
        }
        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
        impl std::borrow::Borrow<str> for $name {
            fn borrow(&self) -> &str {
                &self.0
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
        impl TryFrom<String> for $name {
            type Error = String;
            fn try_from(value: String) -> Result<Self, String> {
                Self::new(value)
            }
        }
        impl TryFrom<&str> for $name {
            type Error = String;
            fn try_from(value: &str) -> Result<Self, String> {
                Self::new(value)
            }
        }
        impl PartialEq<str> for $name {
            fn eq(&self, other: &str) -> bool {
                self.0 == other
            }
        }
        impl PartialEq<&str> for $name {
            fn eq(&self, other: &&str) -> bool {
                self.0 == *other
            }
        }
        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(&self.0)
            }
        }
        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                Self::new(<String as serde::Deserialize>::deserialize(d)?).map_err(serde::de::Error::custom)
            }
        }
        impl schemars::JsonSchema for $name {
            fn inline_schema() -> bool {
                let def: Option<&'static str> = $def;
                def.is_none()
            }
            fn schema_name() -> std::borrow::Cow<'static, str> {
                let def: Option<&'static str> = $def;
                def.unwrap_or(stringify!($name)).into()
            }
            fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
                let mut schema = schemars::json_schema!({ "type": "string" });
                let pattern: Option<&'static str> = $pattern;
                if let Some(pattern) = pattern {
                    schema.insert("pattern".into(), pattern.into());
                }
                let description: Option<&'static str> = $description;
                if let Some(description) = description {
                    schema.insert("description".into(), description.into());
                }
                schema
            }
        }
    };
    ($(#[$doc:meta])* $name:ident, name = $def:literal, pattern = $pattern:literal $(, description = $description:literal)?) => {
        $crate::brand!(@base $(#[$doc])* $name, Some($def), |s| {
            static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new($pattern).unwrap());
            RE.is_match(s)
        }, concat!("a string matching ", $pattern), Some($pattern), $crate::brand!(@opt $($description)?));
    };
    ($(#[$doc:meta])* $name:ident, pattern = $pattern:literal) => {
        $crate::brand!(@base $(#[$doc])* $name, None, |s| {
            static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new($pattern).unwrap());
            RE.is_match(s)
        }, concat!("a string matching ", $pattern), Some($pattern), None);
    };
    ($(#[$doc:meta])* $name:ident, name = $def:literal, check = $check:expr, expected = $expected:expr $(, pattern = $pattern:literal)? $(, description = $description:literal)?) => {
        $crate::brand!(@base $(#[$doc])* $name, Some($def), $check, $expected, $crate::brand!(@opt $($pattern)?), $crate::brand!(@opt $($description)?));
    };
    ($(#[$doc:meta])* $name:ident, check = $check:expr, expected = $expected:expr $(, pattern = $pattern:literal)?) => {
        $crate::brand!(@base $(#[$doc])* $name, None, $check, $expected, $crate::brand!(@opt $($pattern)?), None);
    };
    (@opt) => { None };
    (@opt $value:literal) => { Some($value) };
}

/// Runs a struct-level check after the derived decode, like Effect's `Struct(...).check(filter)`.
///
/// Put `#[serde(remote = "Self")]` on the struct; this supplies the `Serialize`/`Deserialize` impls.
#[macro_export]
macro_rules! checked {
    ($name:ident, $check:expr) => {
        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                $name::serialize(self, s)
            }
        }
        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let value = $name::deserialize(d)?;
                let check: fn(&$name) -> Result<(), String> = $check;
                check(&value).map_err(serde::de::Error::custom)?;
                Ok(value)
            }
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_count_utf16_units_like_javascript() {
        // One astral character is two UTF-16 units.
        assert!(Text::<1, 1>::new("😀").is_err());
        assert!(Text::<1, 2>::new("😀").is_ok());
        assert!(Text::<1, 5>::new("").is_err());
        assert!(Line::<0, 10>::new("a\nb").is_err());
    }

    #[test]
    fn ints_refuse_out_of_range_and_fractions() {
        assert!(serde_json::from_str::<Int<1, 50>>("0").is_err());
        assert!(serde_json::from_str::<Int<1, 50>>("1.5").is_err());
        assert_eq!(serde_json::from_str::<Int<1, 50>>("3.0").unwrap().get(), 3);
    }

    #[test]
    fn unique_lists_refuse_duplicates() {
        assert!(serde_json::from_str::<UniqueList<String, 0, 5>>(r#"["a","a"]"#).is_err());
        assert!(serde_json::from_str::<List<String, 1, 5>>("[]").is_err());
    }
}
