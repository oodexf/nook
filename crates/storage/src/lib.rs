//! SQLite-backed repositories for Minimal AI Chat.
//!
//! Connection management and migrations are introduced in implementation
//! Phase C. Keeping the crate present now fixes the dependency direction before
//! persistence code is added.

/// Returns the storage backend label used in readiness diagnostics.
#[must_use]
pub const fn backend_name() -> &'static str {
    "sqlite"
}

#[cfg(test)]
mod tests {
    use super::backend_name;

    #[test]
    fn backend_is_sqlite() {
        assert_eq!(backend_name(), "sqlite");
    }
}
