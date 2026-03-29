pub(crate) fn extract_json_object(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let without_ansi = strip_ansi_sequences(trimmed);
    let candidate = without_ansi.trim();

    if let (Some(start), Some(end)) = (candidate.find('{'), candidate.rfind('}')) {
        if end >= start {
            return candidate[start..=end].to_string();
        }
    }

    candidate.to_string()
}

fn strip_ansi_sequences(raw: &str) -> String {
    let mut output = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if matches!(chars.peek(), Some('[')) {
                chars.next();
                while let Some(next) = chars.next() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
                continue;
            }
        }

        output.push(ch);
    }

    output
}

#[cfg(test)]
mod tests {
    use super::extract_json_object;

    #[test]
    fn extract_json_object_removes_warning_preamble() {
        let raw = r#" »   Warning: update available
{
  "status": 0,
  "result": {
    "username": "warning@example.com"
  }
}"#;

        let extracted = extract_json_object(raw);

        assert_eq!(
            extracted,
            r#"{
  "status": 0,
  "result": {
    "username": "warning@example.com"
  }
}"#
        );
    }

    #[test]
    fn extract_json_object_removes_ansi_sequences() {
        let extracted = extract_json_object("\u{1b}[33mwarning\u{1b}[0m\n{\"status\":0}");

        assert_eq!(extracted, "{\"status\":0}");
    }
}
