import ApplicationServices
import Foundation

public struct AccessibilityMessagePart: Encodable {
  public let kind: String
  public let text: String?
  public let language: String?
  public let source: String?

  static func text(_ text: String) -> Self {
    Self(kind: "text", text: text, language: nil, source: nil)
  }

  static func code(language: String?, source: String) -> Self {
    Self(kind: "code", text: nil, language: language, source: source)
  }
}

struct AccessibilityMessagePartReader {
  func read(_ payload: AccessibilitySelectedPayload) -> [AccessibilityMessagePart] {
    // AccessibilityMessageStructure establishes the ordered block-level
    // roots of the assistant payload. Interpret each selected root without
    // re-segmenting arbitrary descendants.
    payload.roots.compactMap(readRoot)
  }

  private func readRoot(_ root: AXUIElement) -> AccessibilityMessagePart? {
    if let code = codeContent(in: root) {
      return .code(
        language: codeLanguage(in: root, excluding: code),
        source: textDescendants(of: code).joined()
      )
    }

    let text = visibleText(of: root)
    return text.isEmpty ? nil : .text(text)
  }

  private func codeContent(in root: AXUIElement) -> AXUIElement? {
    firstDescendant(of: root) {
      stringAttribute(kAXSubroleAttribute, of: $0) == "AXCodeStyleGroup"
    }
  }

  private func codeLanguage(
    in root: AXUIElement,
    excluding code: AXUIElement
  ) -> String? {
    // In the observed ChatGPT code-block structure, the language is the
    // short AXStaticText label in the root's chrome branch, while the code
    // itself lives in a separate branch containing AXCodeStyleGroup.
    //
    // Search only branches that do not contain the selected code element.
    // This prevents source text from being mistaken for a language label.
    for branch in children(of: root) where !contains(branch, target: code) {
      let labels = textDescendants(of: branch)
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }

      // The current toolbar has one language label plus controls whose
      // labels are not AXStaticText descendants. Require exactly one
      // short textual label rather than guessing among several strings.
      if labels.count == 1,
        labels[0].count <= 40,
        !labels[0].contains("\n")
      {
        return labels[0].lowercased()
      }
    }
    return nil
  }

  private func visibleText(of element: AXUIElement) -> String {
    let role = stringAttribute(kAXRoleAttribute, of: element)
    let subrole = stringAttribute(kAXSubroleAttribute, of: element)

    if role == kAXStaticTextRole || role == "AXListMarker" {
      return textValue(of: element)
    }

    if role == "AXLink" {
      return children(of: element).map(visibleText).joined()
    }

    if subrole == "AXStrongStyleGroup"
      || subrole == "AXEmphasisStyleGroup"
    {
      return children(of: element).map(visibleText).joined()
    }

    return children(of: element).map(visibleText).joined()
  }

  private func contains(
    _ root: AXUIElement,
    target: AXUIElement
  ) -> Bool {
    if CFEqual(root, target) {
      return true
    }
    return children(of: root).contains {
      contains($0, target: target)
    }
  }

  private func firstDescendant(
    of root: AXUIElement,
    where predicate: (AXUIElement) -> Bool
  ) -> AXUIElement? {
    var pending = Array(children(of: root).reversed())

    while let element = pending.popLast() {
      if predicate(element) {
        return element
      }
      pending.append(contentsOf: children(of: element).reversed())
    }
    return nil
  }

  private func textDescendants(of element: AXUIElement) -> [String] {
    if stringAttribute(kAXRoleAttribute, of: element) == kAXStaticTextRole {
      return [textValue(of: element)]
    }
    return children(of: element).flatMap(textDescendants)
  }

  private func children(of element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        element,
        kAXChildrenAttribute as CFString,
        &value
      ) == .success,
      let children = value as? [AXUIElement]
    else {
      return []
    }
    return children
  }

  private func textValue(of element: AXUIElement) -> String {
    stringAttribute(kAXValueAttribute, of: element)
      ?? stringAttribute(kAXTitleAttribute, of: element)
      ?? stringAttribute(kAXDescriptionAttribute, of: element)
      ?? ""
  }

  private func stringAttribute(
    _ attribute: String,
    of element: AXUIElement
  ) -> String? {
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
