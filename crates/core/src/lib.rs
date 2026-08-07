//! Domain contracts for Minimal AI Chat.
//!
//! The first implementation slice intentionally keeps this crate small. Domain
//! entities and state machines are added here as vertical features land.

/// Human-readable application name shared across backend boundaries.
pub const APP_NAME: &str = "Minimal AI Chat";

#[cfg(test)]
mod tests {
    use super::APP_NAME;

    #[test]
    fn application_name_is_stable() {
        assert_eq!(APP_NAME, "Minimal AI Chat");
    }
}
