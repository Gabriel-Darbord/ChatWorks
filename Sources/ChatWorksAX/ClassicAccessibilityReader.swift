import ApplicationServices
import Foundation

/// ChatGPT Classic exposes assistant code as a heading such as "Bash code
/// block" followed by the exact source in an AXStaticText sibling.
struct ClassicAccessibilityElementSnapshot {
  let role: String?
  let description: String?
  let frame: CGRect?
  let parentTraversalIndex: Int?
}

struct ClassicAccessibilityReader {
  let application: AXUIElement

  func latestParts() -> [AccessibilityMessagePart] {
    let elements = descendantSnapshots(of: application)
    guard
      let conversationFrame =
        elements
        .filter({ $0.role == kAXListRole })
        .compactMap(\.frame)
        .max(by: {
          $0.width == $1.width
            ? $0.width * $0.height < $1.width * $1.height
            : $0.width < $1.width
        })
    else { return [] }
    let assistantLaneEnd = conversationFrame.minX + conversationFrame.width / 3
    guard
      let latestUserContent = elements.lastIndex(where: {
        $0.role == kAXStaticTextRole
          && isUserElement($0, assistantLaneEnd: assistantLaneEnd)
          && staticText(of: $0) != nil
      })
    else { return [] }

    return classicAssistantParts(
      in: Array(elements.dropFirst(latestUserContent + 1)),
      assistantLaneEnd: assistantLaneEnd
    )
  }

  private func frame(of element: AXUIElement) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue)
        == .success,
      AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
      let positionValue,
      let sizeValue
    else { return nil }

    let positionAXValue = positionValue as! AXValue
    let sizeAXValue = sizeValue as! AXValue
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionAXValue, .cgPoint, &position),
      AXValueGetValue(sizeAXValue, .cgSize, &size)
    else { return nil }
    return CGRect(origin: position, size: size)
  }

  private func descendantSnapshots(
    of root: AXUIElement,
    limit: Int = 5_000
  ) -> [ClassicAccessibilityElementSnapshot] {
    var result: [ClassicAccessibilityElementSnapshot] = []
    var pending: [(element: AXUIElement, parentTraversalIndex: Int?)] = [(root, nil)]

    while let next = pending.popLast(), result.count < limit {
      let traversalIndex = result.count
      result.append(
        ClassicAccessibilityElementSnapshot(
          role: stringAttribute(kAXRoleAttribute, of: next.element),
          description: stringAttribute(kAXDescriptionAttribute, of: next.element),
          frame: frame(of: next.element),
          parentTraversalIndex: next.parentTraversalIndex
        )
      )
      var childrenValue: CFTypeRef?
      guard
        AXUIElementCopyAttributeValue(
          next.element,
          kAXChildrenAttribute as CFString,
          &childrenValue
        )
          == .success,
        let children = childrenValue as? [AXUIElement]
      else { continue }
      pending.append(
        contentsOf: children.reversed().map {
          (element: $0, parentTraversalIndex: traversalIndex)
        }
      )
    }
    return result
  }

  private func stringAttribute(_ attribute: String, of element: AXUIElement) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
      return nil
    }
    return value as? String
  }
}

func classicAssistantParts(
  in elements: [ClassicAccessibilityElementSnapshot],
  assistantLaneEnd: CGFloat
) -> [AccessibilityMessagePart] {
  var parts: [PositionedAccessibilityMessagePart] = []
  var consumedCodeSources: Set<Int> = []

  for (index, element) in elements.enumerated() {
    if consumedCodeSources.contains(index) { continue }

    if isCodeBlockHeading(element),
      isAssistantElement(element, assistantLaneEnd: assistantLaneEnd),
      let sourceIndex = elements[(index + 1)...].indices.first(where: {
        elements[$0].parentTraversalIndex == element.parentTraversalIndex
          && elements[$0].role == kAXStaticTextRole
          && isAssistantElement(elements[$0], assistantLaneEnd: assistantLaneEnd)
          && staticText(of: elements[$0]) != nil
      }),
      let source = staticText(of: elements[sourceIndex]),
      let frame = element.frame
    {
      consumedCodeSources.insert(sourceIndex)
      parts.append(
        PositionedAccessibilityMessagePart(
          y: frame.minY,
          traversalIndex: index,
          part: .code(language: codeLanguage(of: element), source: source)
        )
      )
      continue
    }

    if element.role == kAXStaticTextRole,
      isAssistantElement(element, assistantLaneEnd: assistantLaneEnd),
      let text = staticText(of: element),
      let frame = element.frame
    {
      parts.append(
        PositionedAccessibilityMessagePart(
          y: frame.minY,
          traversalIndex: index,
          part: .text(text)
        )
      )
    }
  }

  return accessibilityMessagePartsInVisualOrder(parts)
}

private func isCodeBlockHeading(_ element: ClassicAccessibilityElementSnapshot) -> Bool {
  element.role == kAXHeadingRole
    && element.description?.localizedCaseInsensitiveContains(" code block") == true
}

private func codeLanguage(of element: ClassicAccessibilityElementSnapshot) -> String? {
  guard let description = element.description,
    let marker = description.range(of: " code block", options: .caseInsensitive)
  else { return nil }
  let language = description[..<marker.lowerBound]
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
  return language.isEmpty ? nil : language
}

private func isUserElement(
  _ element: ClassicAccessibilityElementSnapshot,
  assistantLaneEnd: CGFloat
) -> Bool {
  guard let frame = element.frame else { return false }
  return frame.minX >= assistantLaneEnd
}

private func isAssistantElement(
  _ element: ClassicAccessibilityElementSnapshot,
  assistantLaneEnd: CGFloat
) -> Bool {
  guard let frame = element.frame else { return false }
  return frame.minX < assistantLaneEnd
}

private func staticText(of element: ClassicAccessibilityElementSnapshot) -> String? {
  guard let value = element.description else { return nil }
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : trimmed
}
