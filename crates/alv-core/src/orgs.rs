use std::{collections::BTreeMap, time::Duration};

use crate::{auth, cache};

const ORG_LIST_CACHE_KEY: &str = "org/list";
const ORG_LIST_CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgSummary {
    pub username: String,
    pub alias: Option<String>,
    pub is_default_username: bool,
    pub is_default_dev_hub_username: bool,
    pub is_scratch_org: bool,
    pub instance_url: Option<String>,
}

pub fn list_orgs(force_refresh: bool) -> Result<Vec<OrgSummary>, String> {
    if !force_refresh {
        if let Some(cached) = cache::get_string(ORG_LIST_CACHE_KEY) {
            return list_orgs_from_json(&cached);
        }
    }

    let json = auth::run_sf_org_list_json()?;
    let orgs = list_orgs_from_json(&json)?;
    cache::put_string(ORG_LIST_CACHE_KEY, json, ORG_LIST_CACHE_TTL);
    Ok(orgs)
}

pub fn list_orgs_from_json(json: &str) -> Result<Vec<OrgSummary>, String> {
    let parsed = Parser::new(json).parse_value()?;
    let root = match parsed {
        JsonValue::Object(root) => root,
        _ => return Err("org list payload must be a JSON object".to_string()),
    };

    let result = root
        .get("result")
        .and_then(JsonValue::as_object)
        .unwrap_or(&root);

    let mut dedup = BTreeMap::<String, OrgSummary>::new();

    for key in [
        "orgs",
        "nonScratchOrgs",
        "scratchOrgs",
        "sandboxes",
        "devHubs",
        "results",
    ] {
        if let Some(items) = result.get(key).and_then(JsonValue::as_array) {
            for item in items {
                if let Some(org) = parse_org_summary(item) {
                    let dedup_key = if org.username.is_empty() {
                        org.alias.clone().unwrap_or_default()
                    } else {
                        org.username.clone()
                    };
                    if !dedup_key.is_empty() {
                        dedup.entry(dedup_key).or_insert(org);
                    }
                }
            }
        }
    }

    let mut orgs = dedup.into_values().collect::<Vec<_>>();
    orgs.sort_by(|left, right| {
        right
            .is_default_username
            .cmp(&left.is_default_username)
            .then_with(|| {
                let left_key = left.alias.as_deref().unwrap_or(&left.username).to_ascii_lowercase();
                let right_key = right.alias.as_deref().unwrap_or(&right.username).to_ascii_lowercase();
                left_key.cmp(&right_key)
            })
    });
    Ok(orgs)
}

fn parse_org_summary(value: &JsonValue) -> Option<OrgSummary> {
    let object = value.as_object()?;
    let username = object
        .get("username")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let alias = object
        .get("alias")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if username.is_empty() && alias.is_none() {
        return None;
    }

    Some(OrgSummary {
        username,
        alias,
        is_default_username: object
            .get("isDefaultUsername")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false),
        is_default_dev_hub_username: object
            .get("isDefaultDevHubUsername")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false),
        is_scratch_org: object
            .get("isScratchOrg")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false),
        instance_url: object
            .get("instanceUrl")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    })
}

#[derive(Debug, Clone)]
enum JsonValue {
    Null,
    Bool(bool),
    Number(()),
    String(String),
    Array(Vec<JsonValue>),
    Object(BTreeMap<String, JsonValue>),
}

impl JsonValue {
    fn as_array(&self) -> Option<&Vec<JsonValue>> {
        match self {
            Self::Array(values) => Some(values),
            _ => None,
        }
    }

    fn as_object(&self) -> Option<&BTreeMap<String, JsonValue>> {
        match self {
            Self::Object(values) => Some(values),
            _ => None,
        }
    }

    fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(value) => Some(*value),
            _ => None,
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value.as_str()),
            _ => None,
        }
    }
}

struct Parser<'a> {
    source: &'a [u8],
    index: usize,
}

impl<'a> Parser<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source: source.as_bytes(),
            index: 0,
        }
    }

    fn parse_value(&mut self) -> Result<JsonValue, String> {
        self.skip_whitespace();
        match self.peek() {
            Some(b'{') => self.parse_object(),
            Some(b'[') => self.parse_array(),
            Some(b'"') => self.parse_string().map(JsonValue::String),
            Some(b't') | Some(b'f') => self.parse_bool().map(JsonValue::Bool),
            Some(b'n') => self.parse_null(),
            Some(b'-') | Some(b'0'..=b'9') => self.parse_number().map(|_| JsonValue::Number(())),
            Some(other) => Err(format!("unexpected token {}", other as char)),
            None => Err("unexpected end of input".to_string()),
        }
    }

    fn parse_object(&mut self) -> Result<JsonValue, String> {
        self.expect(b'{')?;
        let mut values = BTreeMap::new();
        self.skip_whitespace();

        if self.peek() == Some(b'}') {
            self.index += 1;
            return Ok(JsonValue::Object(values));
        }

        loop {
            self.skip_whitespace();
            let key = self.parse_string()?;
            self.skip_whitespace();
            self.expect(b':')?;
            let value = self.parse_value()?;
            values.insert(key, value);
            self.skip_whitespace();

            match self.peek() {
                Some(b',') => {
                    self.index += 1;
                }
                Some(b'}') => {
                    self.index += 1;
                    break;
                }
                _ => return Err("object must end with ',' or '}'".to_string()),
            }
        }

        Ok(JsonValue::Object(values))
    }

    fn parse_array(&mut self) -> Result<JsonValue, String> {
        self.expect(b'[')?;
        let mut values = Vec::new();
        self.skip_whitespace();

        if self.peek() == Some(b']') {
            self.index += 1;
            return Ok(JsonValue::Array(values));
        }

        loop {
            values.push(self.parse_value()?);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => {
                    self.index += 1;
                }
                Some(b']') => {
                    self.index += 1;
                    break;
                }
                _ => return Err("array must end with ',' or ']'".to_string()),
            }
        }

        Ok(JsonValue::Array(values))
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect(b'"')?;
        let mut raw = Vec::new();
        let mut value = String::new();

        while let Some(byte) = self.next() {
            match byte {
                b'"' => {
                    flush_utf8_bytes(&mut raw, &mut value)?;
                    return Ok(value);
                }
                b'\\' => {
                    flush_utf8_bytes(&mut raw, &mut value)?;
                    let escaped = self.next().ok_or_else(|| "unterminated escape".to_string())?;
                    match escaped {
                        b'"' => value.push('"'),
                        b'\\' => value.push('\\'),
                        b'/' => value.push('/'),
                        b'b' => value.push('\u{0008}'),
                        b'f' => value.push('\u{000C}'),
                        b'n' => value.push('\n'),
                        b'r' => value.push('\r'),
                        b't' => value.push('\t'),
                        b'u' => {
                            let codepoint = self.parse_unicode_codepoint()?;
                            let character = char::from_u32(codepoint)
                                .ok_or_else(|| "invalid unicode escape".to_string())?;
                            value.push(character);
                        }
                        _ => return Err("invalid escape sequence".to_string()),
                    }
                }
                other => raw.push(other),
            }
        }

        Err("unterminated string".to_string())
    }

    fn parse_unicode_codepoint(&mut self) -> Result<u32, String> {
        let first = self.parse_hex_escape_unit()?;
        if !(0xD800..=0xDFFF).contains(&first) {
            return Ok(first as u32);
        }
        if (0xDC00..=0xDFFF).contains(&first) {
            return Err("invalid unicode escape".to_string());
        }
        if self.next() != Some(b'\\') || self.next() != Some(b'u') {
            return Err("invalid unicode escape".to_string());
        }
        let second = self.parse_hex_escape_unit()?;
        if !(0xDC00..=0xDFFF).contains(&second) {
            return Err("invalid unicode escape".to_string());
        }

        let high = (first as u32) - 0xD800;
        let low = (second as u32) - 0xDC00;
        Ok(0x10000 + ((high << 10) | low))
    }

    fn parse_hex_escape_unit(&mut self) -> Result<u16, String> {
        let start = self.index;
        let end = start + 4;
        if end > self.source.len() {
            return Err("incomplete unicode escape".to_string());
        }
        let raw = std::str::from_utf8(&self.source[start..end])
            .map_err(|_| "unicode escape must be valid utf8".to_string())?;
        self.index = end;
        u16::from_str_radix(raw, 16).map_err(|_| "invalid unicode escape".to_string())
    }

    fn parse_bool(&mut self) -> Result<bool, String> {
        if self.consume_bytes(b"true") {
            return Ok(true);
        }
        if self.consume_bytes(b"false") {
            return Ok(false);
        }
        Err("invalid boolean".to_string())
    }

    fn parse_null(&mut self) -> Result<JsonValue, String> {
        if self.consume_bytes(b"null") {
            return Ok(JsonValue::Null);
        }
        Err("invalid null".to_string())
    }

    fn parse_number(&mut self) -> Result<String, String> {
        let start = self.index;
        if self.peek() == Some(b'-') {
            self.index += 1;
        }
        self.consume_digits();
        if self.peek() == Some(b'.') {
            self.index += 1;
            self.consume_digits();
        }
        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            self.index += 1;
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.index += 1;
            }
            self.consume_digits();
        }

        let raw = std::str::from_utf8(&self.source[start..self.index])
            .map_err(|_| "number token should be valid utf8".to_string())?;
        if raw.is_empty() || raw == "-" {
            return Err("invalid number".to_string());
        }
        Ok(raw.to_string())
    }

    fn consume_digits(&mut self) {
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.index += 1;
        }
    }

    fn consume_bytes(&mut self, expected: &[u8]) -> bool {
        if self.source.get(self.index..self.index + expected.len()) == Some(expected) {
            self.index += expected.len();
            return true;
        }
        false
    }

    fn expect(&mut self, expected: u8) -> Result<(), String> {
        self.skip_whitespace();
        match self.next() {
            Some(actual) if actual == expected => Ok(()),
            Some(actual) => Err(format!(
                "expected '{}' but found '{}'",
                expected as char, actual as char
            )),
            None => Err(format!("expected '{}' but reached end of input", expected as char)),
        }
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.index += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.source.get(self.index).copied()
    }

    fn next(&mut self) -> Option<u8> {
        let next = self.peek()?;
        self.index += 1;
        Some(next)
    }
}

fn flush_utf8_bytes(raw: &mut Vec<u8>, value: &mut String) -> Result<(), String> {
    if raw.is_empty() {
        return Ok(());
    }
    let decoded = std::str::from_utf8(raw).map_err(|_| "string token must be valid utf8".to_string())?;
    value.push_str(decoded);
    raw.clear();
    Ok(())
}
