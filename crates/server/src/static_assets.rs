use axum::{
    body::Body,
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../frontend/dist/"]
#[include = "*"]
struct FrontendAssets;

pub async fn serve(uri: Uri) -> Response {
    let requested_path = uri.path().trim_start_matches('/');
    if requested_path == "api" || requested_path.starts_with("api/") {
        return (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "API route not found.",
        )
            .into_response();
    }

    let path = if requested_path.is_empty() {
        "index.html"
    } else {
        requested_path
    };

    let embedded = FrontendAssets::get(path)
        .map(|asset| (asset, path))
        .or_else(|| FrontendAssets::get("index.html").map(|asset| (asset, "index.html")));

    match embedded {
        Some((asset, embedded_path)) => {
            let content_type = mime_guess::from_path(embedded_path).first_or_octet_stream();
            let cache_control = if embedded_path == "index.html" {
                "no-cache"
            } else if embedded_path.starts_with("assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "public, max-age=3600"
            };
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, content_type.as_ref()),
                    (header::CACHE_CONTROL, cache_control),
                ],
                Body::from(asset.data),
            )
                .into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "Frontend assets have not been built.",
        )
            .into_response(),
    }
}
