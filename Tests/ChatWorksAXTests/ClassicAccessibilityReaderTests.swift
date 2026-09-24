import ApplicationServices
import Foundation
import Testing

@testable import ChatWorksAX

@Suite("Classic accessibility reader")
struct ClassicAccessibilityReaderTests {
  @Test("pairs code with its sibling source and preserves intervening prose")
  func structuralCodeSource() {
    let parts = classicAssistantParts(
      in: [
        element(
          role: kAXHeadingRole,
          description: "Tools code block",
          y: 20,
          parent: 4
        ),
        element(
          role: kAXStaticTextRole,
          description: "text2",
          y: 30,
          parent: 9
        ),
        element(
          role: kAXStaticTextRole,
          description: "TOOL BLOCK",
          y: 21,
          parent: 4
        ),
        element(
          role: kAXStaticTextRole,
          description: "text1",
          y: 10,
          parent: 9
        ),
      ],
      assistantLaneEnd: 100
    )

    #expect(
      accessibilityMessageText(parts)
        == "text1\n\n```tools\nTOOL BLOCK\n```\n\ntext2"
    )
  }

  private func element(
    role: String,
    description: String,
    y: CGFloat,
    parent: Int
  ) -> ClassicAccessibilityElementSnapshot {
    ClassicAccessibilityElementSnapshot(
      role: role,
      description: description,
      frame: CGRect(x: 10, y: y, width: 80, height: 10),
      parentTraversalIndex: parent
    )
  }
}
