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
}
