use crate::{
    cli::{SkillInstallArgs, SkillsArgs, SkillsCommand},
    commands::{print_json, OutputMode},
};
use serde::Serialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
};

const SKILL_NAME: &str = "apex-log-viewer-cli";
const SKILL_MD: &str = include_str!("../../../../.codex/skills/apex-log-viewer-cli/SKILL.md");
const OPENAI_YAML: &str =
    include_str!("../../../../.codex/skills/apex-log-viewer-cli/agents/openai.yaml");

#[derive(Debug, Serialize)]
struct SkillInstallResult {
    status: &'static str,
    skill_name: &'static str,
    codex_home: String,
    destination_dir: String,
    files: Vec<&'static str>,
    replaced: bool,
    dry_run: bool,
}

pub fn run(args: SkillsArgs, output: OutputMode) -> Result<i32, String> {
    match args.command {
        SkillsCommand::Install(args) => run_install(args, output),
    }
}

fn run_install(args: SkillInstallArgs, output: OutputMode) -> Result<i32, String> {
    let codex_home = resolve_codex_home(args.codex_home.as_deref())?;
    let destination_dir = codex_home.join("skills").join(SKILL_NAME);
    let existed = destination_dir.exists();
    let status = if args.dry_run {
        if existed {
            "would_replace"
        } else {
            "would_install"
        }
    } else if existed {
        "replaced"
    } else {
        "installed"
    };
    let result = SkillInstallResult {
        status,
        skill_name: SKILL_NAME,
        codex_home: codex_home.display().to_string(),
        destination_dir: destination_dir.display().to_string(),
        files: vec!["SKILL.md", "agents/openai.yaml"],
        replaced: existed && !args.dry_run,
        dry_run: args.dry_run,
    };

    if existed && !args.force && !args.dry_run {
        return Err(format!(
            "skill {SKILL_NAME} already exists at {}; rerun with --force to replace it",
            destination_dir.display()
        ));
    }

    if !args.dry_run {
        install_skill_files(&destination_dir, args.force)?;
    }

    if output.json {
        print_json(&result)?;
    } else if args.dry_run {
        println!(
            "Would {} Codex skill {} at {}",
            if existed { "replace" } else { "install" },
            SKILL_NAME,
            destination_dir.display()
        );
    } else {
        println!(
            "{} Codex skill {} at {}",
            if existed { "Replaced" } else { "Installed" },
            SKILL_NAME,
            destination_dir.display()
        );
    }

    Ok(0)
}

fn install_skill_files(destination_dir: &Path, force: bool) -> Result<(), String> {
    if destination_dir.exists() {
        if !force {
            return Err(format!(
                "skill directory already exists at {}",
                destination_dir.display()
            ));
        }
        fs::remove_dir_all(destination_dir).map_err(|error| {
            format!(
                "failed to remove existing skill directory {}: {error}",
                destination_dir.display()
            )
        })?;
    }

    let agents_dir = destination_dir.join("agents");
    fs::create_dir_all(&agents_dir).map_err(|error| {
        format!(
            "failed to create skill directory {}: {error}",
            agents_dir.display()
        )
    })?;
    fs::write(destination_dir.join("SKILL.md"), SKILL_MD).map_err(|error| {
        format!(
            "failed to write {}: {error}",
            destination_dir.join("SKILL.md").display()
        )
    })?;
    fs::write(agents_dir.join("openai.yaml"), OPENAI_YAML).map_err(|error| {
        format!(
            "failed to write {}: {error}",
            agents_dir.join("openai.yaml").display()
        )
    })?;
    Ok(())
}

fn resolve_codex_home(cli_value: Option<&str>) -> Result<PathBuf, String> {
    if let Some(value) = cli_value.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(value));
    }

    if let Some(value) = env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(value));
    }

    if let Some(value) = env::var_os("HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(value).join(".codex"));
    }

    if let Some(value) = env::var_os("USERPROFILE").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(value).join(".codex"));
    }

    Err("unable to resolve Codex home; set CODEX_HOME or pass --codex-home".to_string())
}

#[cfg(test)]
mod tests {
    use super::resolve_codex_home;
    use std::path::PathBuf;

    #[test]
    fn resolve_codex_home_prefers_cli_value() {
        assert_eq!(
            resolve_codex_home(Some("/tmp/alv-codex")).unwrap(),
            PathBuf::from("/tmp/alv-codex")
        );
    }
}
