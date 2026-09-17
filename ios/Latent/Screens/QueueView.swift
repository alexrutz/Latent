import SwiftUI

/// What is running and what is waiting, and how to stop it.
///
/// Fed by the socket rather than by polling, with one fetch on appear to fill
/// the screen before the first event arrives. The queue changes when a job
/// starts or finishes, which is exactly what the socket already reports.
struct QueueView: View {
    let client: LatentClient
    let live: LiveSocket
    /// Signing out lives here because there is nowhere else it belongs: the
    /// gallery and the generate screen are both about doing something.
    let onSignOut: () -> Void

    @State private var fetched: QueueState?
    @State private var problem: String?

    /// The socket's copy if there is one, otherwise the fetch that filled the
    /// screen. One source at a time, and never a mix of the two.
    private var queue: QueueState? { live.queue ?? fetched }

    var body: some View {
        NavigationStack {
            List {
                Section("Server") {
                    LabeledContent("Address", value: client.baseURL.host() ?? "—")
                    LabeledContent("ComfyUI") {
                        let online = live.state?.comfyOnline ?? false
                        Label(online ? "Online" : "Offline", systemImage: online ? "circle.fill" : "circle")
                            .foregroundStyle(online ? .green : .secondary)
                            .labelStyle(.titleAndIcon)
                            .font(.footnote)
                    }
                    if let error = live.state?.lastError {
                        Text(error).font(.footnote).foregroundStyle(.orange)
                    }
                }

                if let job = live.state?.job {
                    Section("Running") { ProgressRow(job: job) }
                }

                Section("Waiting") {
                    let waiting = queue?.pending ?? []
                    if waiting.isEmpty {
                        Text("Nothing queued.").foregroundStyle(.secondary).font(.footnote)
                    } else {
                        ForEach(waiting) { entry in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.title).lineLimit(1)
                                Text(entry.workflowName).font(.caption2).foregroundStyle(.secondary)
                            }
                            .swipeActions {
                                Button("Cancel", role: .destructive) { cancel(entry) }
                            }
                        }
                    }
                }

                if let queue, !queue.isEmpty {
                    Section {
                        // Stops the one in flight as well as clearing the rest.
                        // Waiting out a render you already know is wrong is the
                        // whole complaint this answers.
                        Button("Stop everything", role: .destructive) { stopEverything() }
                    }
                }

                if let problem {
                    Section {
                        Label(problem, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button("Sign out", role: .destructive, action: onSignOut)
                }
            }
            .navigationTitle("Queue")
            .refreshable { await reload() }
        }
        .task { await reload() }
    }

    private func reload() async {
        do {
            fetched = try await client.queue()
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }

    private func cancel(_ entry: QueueEntry) {
        Task {
            do {
                try await client.cancel(promptId: entry.promptId)
                await reload()
            } catch {
                problem = error.localizedDescription
            }
        }
    }

    private func stopEverything() {
        Task {
            do {
                // Clear what is waiting first, then stop what is running — the
                // other order leaves the next job starting while the queue is
                // still being emptied.
                try await client.cancelAll()
                try await client.interrupt()
                await reload()
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}
