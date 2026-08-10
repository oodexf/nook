//! Domain entities and contracts for `NooK` (栖语).

pub mod conversation;
pub mod generation;
pub mod model;
pub mod provider;
pub mod repository;

/// Human-readable application name shared across backend boundaries.
pub const APP_NAME: &str = "NooK";

#[cfg(test)]
mod tests {
    use super::APP_NAME;

    #[test]
    fn application_name_is_stable() {
        assert_eq!(APP_NAME, "NooK");
    }
}
