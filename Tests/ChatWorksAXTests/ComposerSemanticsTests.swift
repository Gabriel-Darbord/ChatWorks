import Testing

@testable import ChatWorksAX

@Suite("Composer semantics")
struct ComposerSemanticsTests {
  @Test("empty value is empty")
  func emptyValue() {
    #expect(
      ComposerSemantics.isEmpty(
        value: "",
        descriptiveLabels: []
      )
    )
  }

  @Test("whitespace-only value is empty")
  func whitespaceValue() {
    #expect(
      ComposerSemantics.isEmpty(
        value: "  \n\t ",
        descriptiveLabels: []
      )
    )
  }

  @Test("descriptive placeholder is empty")
  func descriptivePlaceholder() {
    #expect(
      ComposerSemantics.isEmpty(
        value: "Ask ChatGPT",
        descriptiveLabels: ["Ask ChatGPT"]
      )
    )
  }

  @Test("placeholder comparison ignores case and surrounding whitespace")
  func normalizedPlaceholder() {
    #expect(
      ComposerSemantics.isEmpty(
        value: "  ASK CHATGPT  ",
        descriptiveLabels: [" Ask ChatGPT "]
      )
    )
  }

  @Test("ordinary draft is not empty")
  func ordinaryDraft() {
    #expect(
      !ComposerSemantics.isEmpty(
        value: "printf 'hello'\n",
        descriptiveLabels: ["Ask ChatGPT"]
      )
    )
  }

  @Test("transformed multiline draft is not empty")
  func transformedMultilineDraft() {
    #expect(
      !ComposerSemantics.isEmpty(
        value: "first section\nsecond section",
        descriptiveLabels: ["Ask ChatGPT"]
      )
    )
  }

  @Test("content is not a descriptive label")
  func contentMustNotSelfClassifyAsPlaceholder() {
    let draft = "CHATWORKS_REAL_DRAFT"

    #expect(
      !ComposerSemantics.isEmpty(
        value: draft,
        descriptiveLabels: []
      )
    )

    // This documents the regression explicitly: generic controlLabels used to
    // include AXValue itself. The semantic API deliberately does not accept a
    // generic control-label collection, preventing that accidental coupling.
  }
}
