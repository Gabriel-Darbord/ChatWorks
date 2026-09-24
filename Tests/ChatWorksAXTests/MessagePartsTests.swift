import Testing

@testable import ChatWorksAX

@Suite("Accessibility message text")
struct MessagePartsTests {
  @Test("preserves prose-only responses")
  func proseOnly() {
    #expect(
      accessibilityMessageText([
        .text("First paragraph."),
        .text("Second paragraph."),
      ]) == "First paragraph.\n\nSecond paragraph."
    )
  }

  @Test("preserves mixed response order and protects nested fences")
  func mixedResponse() {
    #expect(
      accessibilityMessageText([
        .text("Before."),
        .code(language: "text", source: "```nested\nvalue\n```"),
        .text("After."),
      ])
        == "Before.\n\n````text\n```nested\nvalue\n```\n````\n\nAfter."
    )
  }

  @Test("orders scrambled Classic traversal by vertical position")
  func visualOrder() {
    let parts = accessibilityMessagePartsInVisualOrder([
      PositionedAccessibilityMessagePart(
        y: 20,
        traversalIndex: 0,
        part: .code(language: "text", source: "BLOCK")
      ),
      PositionedAccessibilityMessagePart(y: 30, traversalIndex: 1, part: .text("text2")),
      PositionedAccessibilityMessagePart(y: 10, traversalIndex: 2, part: .text("text1")),
    ])

    #expect(accessibilityMessageText(parts) == "text1\n\n```text\nBLOCK\n```\n\ntext2")
  }

  @Test("keeps traversal order when parts share a vertical position")
  func traversalOrderTieBreak() {
    let parts = accessibilityMessagePartsInVisualOrder([
      PositionedAccessibilityMessagePart(y: 10, traversalIndex: 2, part: .text("second")),
      PositionedAccessibilityMessagePart(y: 10, traversalIndex: 1, part: .text("first")),
    ])

    #expect(accessibilityMessageText(parts) == "first\n\nsecond")
  }
}
