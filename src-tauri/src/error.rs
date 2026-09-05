use serde::{Serialize, Serializer, ser::SerializeStruct};

#[derive(Debug)]
pub enum LoomError { Http(String), Timeout, Parse(String), Git(String), NotFound(String), Unsupported(String) }

impl std::fmt::Display for LoomError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoomError::Http(m) => write!(f, "http: {m}"),
            LoomError::Timeout => write!(f, "timeout"),
            LoomError::Parse(m) => write!(f, "parse: {m}"),
            LoomError::Git(m) => write!(f, "git: {m}"),
            LoomError::NotFound(m) => write!(f, "not found: {m}"),
            LoomError::Unsupported(m) => write!(f, "unsupported: {m}"),
        }
    }
}
impl std::error::Error for LoomError {}

impl Serialize for LoomError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let kind = match self {
            LoomError::Http(_) => "http", LoomError::Timeout => "timeout",
            LoomError::Parse(_) => "parse", LoomError::Git(_) => "git",
            LoomError::NotFound(_) => "not_found",
            LoomError::Unsupported(_) => "unsupported",
        };
        let mut st = s.serialize_struct("LoomError", 2)?;
        st.serialize_field("kind", kind)?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}
