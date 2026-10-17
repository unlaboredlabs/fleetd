//! JSON that keeps object keys in file order, as `JSON.parse`/`JSON.stringify` do. T3's settings.json and the node's
//! node.json are compared byte for byte on every `machine add`, so their key order must survive a rewrite. (serde_json's
//! `preserve_order` would do it, but features unify across the workspace and it reorders the contracts' schemas.)

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    Object(Object),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Object(Vec<(String, Json)>);

impl Object {
    pub fn get(&self, key: &str) -> Option<&Json> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// Replaces a key's value in place, or appends it: what `{ ...o, [key]: value }` does.
    pub fn insert(&mut self, key: &str, value: Json) {
        match self.0.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => self.0.push((key.to_owned(), value)),
        }
    }
}

impl Json {
    pub fn as_object(&self) -> Option<&Object> {
        match self {
            Json::Object(o) => Some(o),
            _ => None,
        }
    }

    pub fn str(value: &str) -> Json {
        Json::String(value.to_owned())
    }

    pub fn parse(text: &str) -> Result<Json, String> {
        serde_json::from_str(text).map_err(|error| error.to_string())
    }

    /// `JSON.stringify(value, null, 2)`.
    pub fn pretty(&self) -> String {
        serde_json::to_string_pretty(self).expect("JSON serializes")
    }
}

impl From<serde_json::Value> for Json {
    fn from(value: serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => Json::Null,
            serde_json::Value::Bool(b) => Json::Bool(b),
            serde_json::Value::Number(n) => Json::Number(n),
            serde_json::Value::String(s) => Json::String(s),
            serde_json::Value::Array(items) => {
                Json::Array(items.into_iter().map(Json::from).collect())
            }
            serde_json::Value::Object(map) => Json::Object(Object(
                map.into_iter().map(|(k, v)| (k, Json::from(v))).collect(),
            )),
        }
    }
}

impl Serialize for Json {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Json::Null => s.serialize_unit(),
            Json::Bool(b) => s.serialize_bool(*b),
            Json::Number(n) => n.serialize(s),
            Json::String(text) => s.serialize_str(text),
            Json::Array(items) => {
                let mut seq = s.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Json::Object(Object(entries)) => {
                let mut map = s.serialize_map(Some(entries.len()))?;
                for (key, value) in entries {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

struct JsonVisitor;

impl<'de> Visitor<'de> for JsonVisitor {
    type Value = Json;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("JSON")
    }
    fn visit_unit<E>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }
    fn visit_bool<E>(self, b: bool) -> Result<Json, E> {
        Ok(Json::Bool(b))
    }
    fn visit_u64<E>(self, n: u64) -> Result<Json, E> {
        Ok(Json::Number(n.into()))
    }
    fn visit_i64<E>(self, n: i64) -> Result<Json, E> {
        Ok(Json::Number(n.into()))
    }
    fn visit_f64<E>(self, n: f64) -> Result<Json, E> {
        Ok(serde_json::Number::from_f64(n).map_or(Json::Null, Json::Number))
    }
    fn visit_str<E>(self, s: &str) -> Result<Json, E> {
        Ok(Json::String(s.to_owned()))
    }
    fn visit_string<E>(self, s: String) -> Result<Json, E> {
        Ok(Json::String(s))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Json::Array(items))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
        // A repeated key keeps its first place and its last value, as JSON.parse does.
        let mut object = Object::default();
        while let Some((key, value)) = map.next_entry::<String, Json>()? {
            object.insert(&key, value);
        }
        Ok(Json::Object(object))
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Json, D::Error> {
        d.deserialize_any(JsonVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_key_order_through_a_rewrite() {
        let mut parsed = Json::parse(r#"{"z":1,"a":{"y":true,"b":[1,"x"]},"z":2}"#).unwrap();
        let Json::Object(object) = &mut parsed else {
            panic!("object")
        };
        object.insert("a", Json::Null);
        object.insert("m", Json::str("new"));
        assert_eq!(
            serde_json::to_string(&parsed).unwrap(),
            r#"{"z":2,"a":null,"m":"new"}"#
        );
    }
}
