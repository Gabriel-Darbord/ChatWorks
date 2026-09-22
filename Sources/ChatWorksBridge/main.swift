import ChatWorksAX
import Foundation

struct UsageError: LocalizedError {
  var errorDescription: String? {
    "Usage: chatworks-ax [--bundle-id <identifier>] [--interaction background|focus|pointer] <command>"
  }
}

private func parseConnection(
  _ arguments: [String]
) throws -> (bundleIdentifier: String?, interactionPolicy: InteractionPolicy, command: [String]) {
  var bundleIdentifier: String?
  var interactionPolicy: InteractionPolicy = .background
  var index = 0

  while index < arguments.count {
    switch arguments[index] {
    case "--bundle-id":
      guard bundleIdentifier == nil, index + 1 < arguments.count, !arguments[index + 1].isEmpty
      else { throw UsageError() }
      bundleIdentifier = arguments[index + 1]
      index += 2
    case "--interaction":
      guard index + 1 < arguments.count,
        let policy = InteractionPolicy(rawValue: arguments[index + 1])
      else { throw UsageError() }
      interactionPolicy = policy
      index += 2
    default:
      return (bundleIdentifier, interactionPolicy, Array(arguments[index...]))
    }
  }

  throw UsageError()
}

@main
struct ChatWorksBridge {
  static func main() {
    do {
      let target = try parseConnection(Array(CommandLine.arguments.dropFirst()))
      let arguments = target.command

      let chat = try ChatGPTAccessibility.connect(
        bundleIdentifier: target.bundleIdentifier,
        interactionPolicy: target.interactionPolicy
      )
      defer { chat.restoreFocus() }
      switch arguments {
      case ["read"]:
        FileHandle.standardOutput.write(Data(try chat.latestAssistantRawText().utf8))
      case ["message-parts"]:
        FileHandle.standardOutput.write(
          try JSONEncoder().encode(chat.latestAssistantParts())
        )
      case ["assistant-observation"]:
        FileHandle.standardOutput.write(
          try JSONEncoder().encode(chat.latestAssistantObservation())
        )
      case ["assistant-state"]:
        FileHandle.standardOutput.write(try JSONEncoder().encode(chat.assistantMessageState()))
      case ["composer-state"]:
        FileHandle.standardOutput.write(
          try JSONEncoder().encode(chat.composerState())
        )
      case ["scroll-to-bottom"]:
        try chat.scrollToBottom()
      case ["stage"]:
        try chat.stage(
          String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self))
      case ["stage-and-send"]:
        try chat.stageAndSend(
          String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self))
      case ["guarded-stage-and-send"]:
        let text = String(
          decoding: FileHandle.standardInput.readDataToEndOfFile(),
          as: UTF8.self
        )
        FileHandle.standardOutput.write(
          try JSONEncoder().encode(chat.guardedStageAndSend(text))
        )
      case ["send"]:
        try chat.send()

      case ["submit-staged-by-send-control"]:
        try chat.submitStagedBySendControl()

      case ["submit-staged-unconfirmed"]:
        try chat.submitStagedUnconfirmed()
      case ["list-chats"]:
        let data = try JSONEncoder().encode(chat.chatReferences())
        FileHandle.standardOutput.write(data)
      case let arguments where arguments.count == 2 && arguments[0] == "select-chat":
        try chat.selectChat(arguments[1])
      case let arguments where arguments.count == 3 && arguments[0] == "rename-chat":
        try chat.renameChat(
          arguments[1],
          newTitle: arguments[2]
        )
      case ["new-chat"]:
        try chat.newChat()

      case ["inspect-composer"]:
        FileHandle.standardOutput.write(
          try JSONEncoder().encode(chat.inspector().composerSnapshot())
        )
      case ["inspect-conversation"]:
        FileHandle.standardOutput.write(
          try JSONEncoder().encode(chat.inspector().conversationSnapshot())
        )
      case ["inspect-all"]:
        FileHandle.standardOutput.write(
          try JSONEncoder().encode(chat.inspector().allElements())
        )
      case ["inspect-chat-attributes"]:
        FileHandle.standardOutput.write(
          try JSONEncoder().encode(chat.chatControlAttributeDiagnostics())
        )
      case let arguments where arguments.first == "inspect":
        let data = try JSONEncoder().encode(
          chat.inspector().controls(matching: Array(arguments.dropFirst())))
        FileHandle.standardOutput.write(data)
      case let arguments where arguments.first == "inspect-elements":
        let data = try JSONEncoder().encode(
          chat.inspector().elements(matching: Array(arguments.dropFirst())))
        FileHandle.standardOutput.write(data)
      default:
        throw UsageError()
      }
    } catch AccessibilityError.copyControlNotFound {
      fputs("chatworks-ax: No assistant message is available to copy.\n", stderr)
      Foundation.exit(2)
    } catch AccessibilityError.assistantMessageNotFound {
      fputs("chatworks-ax: No assistant message is available.\n", stderr)
      Foundation.exit(2)
    } catch {
      fputs("chatworks-ax: \(error.localizedDescription)\n", stderr)
      Foundation.exit(1)
    }
  }
}
