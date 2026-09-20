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

  func latestMessagePayload(
    from payloads: [AccessibilityMessagePayload]
  ) -> AccessibilitySelectedPayload? {
    guard
      let metadata = payloads.max(by: {
        $0.anchorTraversalIndex < $1.anchorTraversalIndex
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

  func role(of payload: AccessibilitySelectedPayload) -> String? {
    switch payload.metadata.anchorLabel {
    case "You said:":
      return "user"
    case "ChatGPT said:":
      return "assistant"
    default:
      return nil
    }
  }

  func semanticFingerprint(
    of payload: AccessibilitySelectedPayload
  ) -> String {
    var components = [payload.metadata.anchorLabel]

    for rootIndex in payload.metadata.rootTraversalIndices {
      appendSemanticComponents(
        from: rootIndex,
        into: &components
      )
    }

    return components.joined(separator: "\u{1f}")
  }

  func diagnosticPayloadSequence() -> [String] {
    payloads().compactMap { metadata in
      guard let payload = selectedPayload(from: metadata) else {
        return nil
      }

      let fingerprint = semanticFingerprint(of: payload)
      let hash = fingerprint.utf8.reduce(UInt64(14_695_981_039_346_656_037)) {
        value, byte in
        (value ^ UInt64(byte)) &* 1_099_511_628_211
      }

      return "\(role(of: payload) ?? "unknown"):" + String(format: "%016llx", hash)
    }
  }

  func latestUserPayloadFollowingAssistant(
    fingerprint assistantFingerprint: String
  ) -> AccessibilitySelectedPayload? {
    let payloads = payloads()

    guard payloads.count >= 2,
      let latestMetadata = payloads.last,
      latestMetadata.anchorLabel == "You said:",
      let latestIndex = payloads.indices.last
    else {
      return nil
    }

    let predecessorMetadata = payloads[payloads.index(before: latestIndex)]

    guard predecessorMetadata.anchorLabel == "ChatGPT said:",
      let predecessor = selectedPayload(from: predecessorMetadata),
      semanticFingerprint(of: predecessor) == assistantFingerprint
    else {
      return nil
    }

    return selectedPayload(from: latestMetadata)
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

  private func selectedPayload(
    from metadata: AccessibilityMessagePayload
  ) -> AccessibilitySelectedPayload? {
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

  private func appendSemanticComponents(
    from rootIndex: Int,
    into components: inout [String]
  ) {
    var pending = [rootIndex]
    var visited = Set<Int>()

    while let index = pending.popLast() {
      guard visited.insert(index).inserted,
        let element = byIndex[index]
      else {
        continue
      }

      components.append(element.role ?? "")
      components.append(element.title ?? "")
      components.append(element.description ?? "")
      components.append(element.value ?? "")

      pending.append(contentsOf: element.childTraversalIndices.reversed())
    }
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
