// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AutopodUI",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "AutopodUI", targets: ["AutopodUI"]),
    ],
    targets: [
        .target(
            name: "AutopodUI",
            path: "Sources/AutopodUI"
        ),
    ]
)
