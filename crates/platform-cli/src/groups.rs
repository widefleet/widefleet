use clap::{Args, Subcommand};
use platform_core::{
    Result,
    http::{Api, json},
};
use reqwest::Method;
use serde::{Deserialize, Serialize};

#[derive(Args)]
pub struct Options {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Find company groups and their identifiers for app permission checks.
    Search {
        query: String,
        #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u8).range(1..=50))]
        limit: u8,
        /// Return the same structured result for every directory integration.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Deserialize, Serialize)]
struct Group {
    id: String,
    name: String,
    description: Option<String>,
    source: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    groups: Vec<Group>,
    has_more: bool,
}

pub async fn run(api: &Api, token: &str, options: Options) -> Result<()> {
    match options.command {
        Command::Search {
            query,
            limit,
            json: json_output,
        } => {
            let result: SearchResult = json(
                api.authenticated(Method::GET, "/groups", token)
                    .query(&[("query", query), ("limit", limit.to_string())])
                    .send()
                    .await?,
            )
            .await?;
            if json_output {
                return super::print_json(&result);
            }
            for group in &result.groups {
                println!("{}\t{}\t{}", group.id, group.name, group.source);
            }
            if result.groups.is_empty() {
                println!("No matching company groups.");
            }
            if result.has_more {
                eprintln!("More groups match. Narrow the search or increase --limit.");
            }
            Ok(())
        }
    }
}
