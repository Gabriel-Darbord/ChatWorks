import ApplicationServices
import Foundation

struct AccessibilityMessagePayload {
  let anchorLabel: String
  let anchorTraversalIndex: Int
  let rootTraversalIndices: [Int]
}

struct AccessibilitySelectedPayload {
  let metadata: AccessibilityMessagePayload
  let roots: [AXUIElement]
}

struct AccessibilityMessageSibling {
  let traversalIndex: Int
  let role: String?
  let title: String?
  let description: String?
  let value: String?
  let containsRenderedText: Bool
}

struct AccessibilityMessageStructure {
  private struct Element {
    let traversalIndex: Int
    let role: String?
    let title: String?
    let description: String?
    let value: String?
    let parentTraversalIndex: Int?
    let childTraversalIndices: [Int]
  }

  private let accessibilityElements: [AXUIElement]
  private let elements: [Element]
  private let byIndex: [Int: Element]

  init(application: AXUIElement, limit: Int = 5_000) {
    struct CapturedElement {
      let element: AXUIElement
      let parentTraversalIndex: Int?
      var childTraversalIndices: [Int]
    }

    var captured: [CapturedElement] = []
    var pending: [(element: AXUIElement, parentTraversalIndex: Int?)] = [
      (application, nil)
    ]

    while let next = pending.popLast(), captured.count < limit {
      let traversalIndex = captured.count

      captured.append(
        CapturedElement(
          element: next.element,
          parentTraversalIndex: next.parentTraversalIndex,
          childTraversalIndices: []
        )
      )

      if let parentTraversalIndex = next.parentTraversalIndex {
        captured[parentTraversalIndex].childTraversalIndices.append(
          traversalIndex
        )
      }

      var childrenValue: CFTypeRef?
      guard
        AXUIElementCopyAttributeValue(
          next.element,
          kAXChildrenAttribute as CFString,
          &childrenValue
        ) == .success,
        let children = childrenValue as? [AXUIElement]
      else {
        continue
      }

      // pending is LIFO. Push children in reverse so the resulting traversal
      // retains AX child order.
      for child in children.reversed() {
        pending.append(
          (child, traversalIndex)
        )
      }
    }

    self.accessibilityElements = captured.map(\.element)
    self.elements = captured.enumerated().map { traversalIndex, captured in
      Element(
        traversalIndex: traversalIndex,
        role: Self.stringAttribute(kAXRoleAttribute, of: captured.element),
        title: Self.stringAttribute(kAXTitleAttribute, of: captured.element),
        description: Self.stringAttribute(
          kAXDescriptionAttribute,
          of: captured.element
        ),
        value: Self.stringAttribute(kAXValueAttribute, of: captured.element),
        parentTraversalIndex: captured.parentTraversalIndex,
        childTraversalIndices: captured.childTraversalIndices
      )
    }
    self.byIndex = Dictionary(
      uniqueKeysWithValues: elements.map { ($0.traversalIndex, $0) }
    )
  }

  func payloads() -> [AccessibilityMessagePayload] {
    let anchors = elements.filter {
      $0.role == kAXHeadingRole
        && ["You said:", "ChatGPT said:"].contains($0.title ?? "")
    }

    return anchors.compactMap { anchor in
      guard let parentIndex = anchor.parentTraversalIndex,
        let parent = byIndex[parentIndex],
        let anchorPosition = parent.childTraversalIndices.firstIndex(
          of: anchor.traversalIndex
        )
      else {
        return nil
      }

      var roots: [Int] = []

      for index in parent.childTraversalIndices.dropFirst(anchorPosition + 1) {
        guard let candidate = byIndex[index] else { continue }

        if candidate.role == kAXHeadingRole,
          ["You said:", "ChatGPT said:"].contains(candidate.title ?? "")
        {
          break
        }

        if containsRenderedText(index) {
          roots.append(index)
        }
      }

      return AccessibilityMessagePayload(
        anchorLabel: anchor.title ?? "",
        anchorTraversalIndex: anchor.traversalIndex,
        rootTraversalIndices: roots
      )
    }
  }

  func latestAssistantPayload() -> AccessibilitySelectedPayload? {
    latestAssistantPayload(from: payloads())
  }

  func latestMessageRole() -> String? {
    guard
      let anchor = elements.last(where: {
        $0.role == kAXHeadingRole
          && ["You said:", "ChatGPT said:"].contains($0.title ?? "")
      })
    else {
      return nil
    }

    switch anchor.title {
    case "You said:":
      return "user"
    case "ChatGPT said:":
      return "assistant"
    default:
      return nil
    }
  }

  func latestAssistantSiblingSequence() -> [AccessibilityMessageSibling] {
    guard
      let anchor = elements.last(where: {
        $0.role == kAXHeadingRole && $0.title == "ChatGPT said:"
      }),
      let parentIndex = anchor.parentTraversalIndex,
      let parent = byIndex[parentIndex],
      let anchorPosition = parent.childTraversalIndices.firstIndex(
        of: anchor.traversalIndex
      )
    else {
      return []
    }

    return parent.childTraversalIndices
      .dropFirst(anchorPosition + 1)
      .compactMap { index in
        guard let element = byIndex[index] else { return nil }
        return AccessibilityMessageSibling(
          traversalIndex: index,
          role: element.role,
          title: element.title,
          description: element.description,
          value: element.value,
          containsRenderedText: containsRenderedText(index)
        )
      }
  }

  func latestAssistantPayload(
    from payloads: [AccessibilityMessagePayload]
  ) -> AccessibilitySelectedPayload? {
    guard
      let metadata = payloads.last(where: {
        $0.anchorLabel == "ChatGPT said:"
      })
    else {
      return nil
    }

    let roots = metadata.rootTraversalIndices.compactMap { index in
      accessibilityElements.indices.contains(index)
        ? accessibilityElements[index]
        : nil
    }
    guard roots.count == metadata.rootTraversalIndices.count else {
      return nil
    }

    return AccessibilitySelectedPayload(
      metadata: metadata,
      roots: roots
    )
  }

  private func containsRenderedText(_ rootIndex: Int) -> Bool {
    var pending = [rootIndex]
    var visited = Set<Int>()

    while let index = pending.popLast() {
      guard visited.insert(index).inserted,
        let element = byIndex[index]
      else {
        continue
      }

      if ["AXStaticText", "AXListMarker"].contains(element.role ?? "") {
        let values = [
          element.title,
          element.description,
          element.value,
        ].compactMap { $0 }
        if values.contains(where: { !$0.isEmpty }) {
          return true
        }
      }

      pending.append(contentsOf: element.childTraversalIndices.reversed())
    }
    return false
  }

  private static func stringAttribute(_ attribute: String, of element: AXUIElement) -> String? {
    var value: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        element,
        attribute as CFString,
        &value
      ) == .success
    else {
      return nil
    }
    return value as? String
  }
}
