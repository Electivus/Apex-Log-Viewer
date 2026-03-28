use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandInvocation {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
}

pub(crate) fn build_command_invocation<S>(
    program: &str,
    args: &[S],
) -> Result<CommandInvocation, String>
where
    S: AsRef<str>,
{
    if cfg!(windows) && program.eq_ignore_ascii_case("sf") {
        if let Ok(explicit_path) = std::env::var("ALV_SF_BIN_PATH") {
            let trimmed = explicit_path.trim();
            if !trimmed.is_empty() {
                return Ok(build_windows_sf_invocation(trimmed, args));
            }
        }

        if let Some(resolved_path) = resolve_windows_sf_path(program)? {
            return Ok(build_windows_sf_invocation(&resolved_path, args));
        }
    }

    Ok(CommandInvocation {
        program: program.to_string(),
        args: args.iter().map(|value| value.as_ref().to_string()).collect(),
    })
}

fn resolve_windows_sf_path(program: &str) -> Result<Option<String>, String> {
    if !cfg!(windows) {
        return Ok(None);
    }

    let output = Command::new("where.exe")
        .arg(program)
        .output()
        .map_err(|error| format!("where.exe failed to start: {error}"))?;

    if !output.status.success() && output.stdout.is_empty() {
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let candidates = parse_where_candidates(&stdout);
    Ok(pick_windows_sf_candidate(&candidates))
}

pub(crate) fn parse_where_candidates(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

pub(crate) fn pick_windows_sf_candidate(candidates: &[String]) -> Option<String> {
    candidates
        .iter()
        .find(|candidate| candidate.to_ascii_lowercase().ends_with(".cmd"))
        .cloned()
        .or_else(|| candidates.first().cloned())
}

pub(crate) fn build_windows_sf_invocation<S>(sf_path: &str, args: &[S]) -> CommandInvocation
where
    S: AsRef<str>,
{
    let normalized_path = sf_path.trim().to_string();
    let lowercase = normalized_path.to_ascii_lowercase();
    if lowercase.ends_with(".cmd") {
        let mut argv = vec![
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            normalized_path,
        ];
        argv.extend(args.iter().map(|value| value.as_ref().to_string()));
        return CommandInvocation {
            program: "cmd.exe".to_string(),
            args: argv,
        };
    }

    CommandInvocation {
        program: normalized_path,
        args: args.iter().map(|value| value.as_ref().to_string()).collect(),
    }
}
