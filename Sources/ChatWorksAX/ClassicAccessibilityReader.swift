import ApplicationServices
import Foundation

/// ChatGPT Classic exposes assistant code as a heading such as "Bash code
/// block" followed by the exact source in an AXStaticText sibling.
struct ClassicAccessibilityReader {
  let application: AXUIElement

  func latestParts() -> [AccessibilityMessagePart] {
    let elements = descendants(of: application)
    guard let conversationFrame = conversationFrame(in: elements) else { return [] }
    let assistantLaneEnd = conversationFrame.minX + conversationFrame.width / 3
    guard
      let latestUserContent = elements.lastIndex(where: {
        isUserStaticText($0, assistantLaneEnd: assistantLaneEnd)
      })
    else { return [] }

    return assistantParts(
      in: Array(elements.dropFirst(latestUserContent + 1)),
      assistantLaneEnd: assistantLaneEnd
    )
  }

  private func isCodeBlockHeading(_ element: AXUIElement) -> Bool {
    guard role(of: element) == kAXHeadingRole,
      let description = stringAttribute(kAXDescriptionAttribute, of: element)
    else { return false }
    return description.localizedCaseInsensitiveContains(" code block")
  }

  private func language(of element: AXUIElement) -> String? {
    guard let description = stringAttribute(kAXDescriptionAttribute, of: element),
      let marker = description.range(of: " code block", options: .caseInsensitive)
    else { return nil }
    let language = description[..<marker.lowerBound]
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
    return language.isEmpty ? nil : language
  }

  private func isStaticText(_ element: AXUIElement) -> Bool {
    role(of: element) == kAXStaticTextRole
  }

  private func assistantParts(
    in elements: [AXUIElement],
    assistantLaneEnd: CGFloat
  ) -> [AccessibilityMessagePart] {
    struct PositionedPart {
      let y: CGFloat
      let traversalIndex: Int
      let part: AccessibilityMessagePart
    }

    var parts: [PositionedPart] = []
    var index = 0

    while index < elements.count {
      let element = elements[index]
      if isCodeBlockHeading(element),
        isAssistantElement(element, assistantLaneEnd: assistantLaneEnd),
        let sourceIndex = elements[(index + 1)...].indices.first(where: {
          isStaticText(elements[$0])
            && isAssistantElement(elements[$0], assistantLaneEnd: assistantLaneEnd)
        }),
        let source = staticText(of: elements[sourceIndex])
      {
        if let position = frame(of: element) {
          parts.append(
            PositionedPart(
              y: position.minY,
              traversalIndex: index,
              part: .code(language: language(of: element), source: source)
            )
          )
        }
        index = sourceIndex + 1
        continue
      }

      if isStaticText(element), isAssistantElement(element, assistantLaneEnd: assistantLaneEnd),
        let text = staticText(of: element)
      {
        if let position = frame(of: element) {
          parts.append(
            PositionedPart(
              y: position.minY,
              traversalIndex: index,
              part: .text(text)
            )
          )
        }
      }
      index += 1
    }

    return
      parts
      .sorted {
        if $0.y == $1.y { return $0.traversalIndex < $1.traversalIndex }
        return $0.y < $1.y
      }
      .map(\.part)
  }

  private func isUserStaticText(_ element: AXUIElement, assistantLaneEnd: CGFloat) -> Bool {
    guard isStaticText(element), let frame = frame(of: element) else { return false }
    return frame.minX >= assistantLaneEnd && staticText(of: element) != nil
  }

  private func isAssistantElement(_ element: AXUIElement, assistantLaneEnd: CGFloat) -> Bool {
    guard let frame = frame(of: element) else { return false }
    return frame.minX < assistantLaneEnd
  }

  private func staticText(of element: AXUIElement) -> String? {
    guard let value = stringAttribute(kAXDescriptionAttribute, of: element) else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private func conversationFrame(in elements: [AXUIElement]) -> CGRect? {
    guard
      let frame =
        elements
        .filter(isConversationList)
        .compactMap(frame)
        .max(by: {
          $0.width == $1.width
            ? $0.width * $0.height < $1.width * $1.height
            : $0.width < $1.width
        })
    else { return nil }
    return frame
  }

  private func isConversationList(_ element: AXUIElement) -> Bool {
    role(of: element) == kAXListRole
  }

  private func role(of element: AXUIElement) -> String? {
    stringAttribute(kAXRoleAttribute, of: element)
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

  private func descendants(of root: AXUIElement, limit: Int = 5_000) -> [AXUIElement] {
    var result: [AXUIElement] = []
    var pending = [root]

    while let next = pending.popLast(), result.count < limit {
      result.append(next)
      var childrenValue: CFTypeRef?
      guard
        AXUIElementCopyAttributeValue(next, kAXChildrenAttribute as CFString, &childrenValue)
          == .success,
        let children = childrenValue as? [AXUIElement]
      else { continue }
      pending.append(contentsOf: children.reversed())
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
