use serde::Serialize;
use std::collections::HashMap;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

#[derive(Default, Serialize)]
pub struct Comment {
    pub summary: String,
    pub remarks: String,
    pub examples: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deprecated: Option<String>,
}

#[derive(Default)]
pub struct Documentation {
    pub comment: Comment,
    pub parameters: HashMap<String, String>,
    pub returns: String,
    pub throws: Vec<String>,
}

// tsrs parses the comment and its tags; this only selects the public TSDoc fields.
pub fn documentation(node: P<Node>) -> Documentation {
    let mut result = Documentation::default();
    let mut location = Some(node);
    while let Some(node) = location {
        if let Some(doc) = node.jsdoc(None).last() {
            result.comment.summary = text(*doc);
            if let Some(tags) = doc.as_jsdoc().tags {
                for &tag in tags.nodes() {
                    let value = text(tag);
                    match tag.tag_name().text() {
                        "remarks" => result.comment.remarks = value,
                        "example" => result.comment.examples.push(value),
                        "deprecated" => result.comment.deprecated = Some(value),
                        "returns" | "return" => result.returns = value,
                        "throws" => result.throws.push(value),
                        "param" if tag.kind() == Kind::JSDocParameterTag => {
                            let name = tag.as_jsdoc_parameter_or_property_tag().name();
                            if name.kind() == Kind::Identifier {
                                result.parameters.insert(
                                    name.text().into(),
                                    value.trim_start_matches('-').trim_start().into(),
                                );
                            }
                        }
                        _ => {}
                    }
                }
            }
            break;
        }
        location = ast::get_next_jsdoc_comment_location(node);
    }
    result
}

fn text(node: P<Node>) -> String {
    tsrs_scanner::get_text_of_jsdoc_comment(node.comment_list())
        .trim()
        .into()
}
