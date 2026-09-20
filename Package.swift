// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ChatWorks",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "ChatWorksAX", targets: ["ChatWorksAX"]),
        .executable(name: "chatworks-ax", targets: ["ChatWorksBridge"])
    ],
    targets: [
        .target(name: "ChatWorksAX"),
        .executableTarget(name: "ChatWorksBridge", dependencies: ["ChatWorksAX"]),
        .testTarget(name: "ChatWorksAXTests", dependencies: ["ChatWorksAX"])
    ]
)
