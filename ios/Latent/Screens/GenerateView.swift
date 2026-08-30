import SwiftUI

/// A prompt, a workflow, and a button.
///
/// Deliberately not the web app's form. That screen builds every control a
/// graph declares — thirty of them on a busy workflow — and reproducing it here
/// would be a second implementation of `paramSchema` in another language, kept
/// in step by hand. What a phone is actually for is the other thing: a prompt
/// you thought of while away from the desk, sent to a workflow you already set
/// up. Everything else keeps the values the web app last submitted.
struct GenerateView: View {
    let client: LatentClient
    let live: LiveSocket

    @State private var workflows: [WorkflowSummary] = []
    @State private var chosen: WorkflowSummary?
    @State private var detail: WorkflowDetail?
    @State private var prompt = ""
    @State private var batch = 1
    @State private var sending = false
    @State private var problem: String?
    @State private var note: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Workflow") {
                    if workflows.isEmpty {
                        Text("No workflows are switched on. Import one in Latent first.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Workflow", selection: $chosen) {
                            ForEach(workflows) { workflow in
                                Text(workflow.name).tag(Optional(workflow))
                            }
                        }
                    }
                }

                Section {
                    TextField("Describe the picture…", text: $prompt, axis: .vertical)
                        .lineLimit(3...8)
                } header: {
                    Text("Prompt")
                } footer: {
                    // Said plainly, because it is the one surprising thing about
                    // this screen: the render uses the rest of the settings from
                    // wherever the workflow was last used.
                    if let detail, detail.promptField == nil {
                        Text("This workflow has no prompt field, so the text above will not be used.")
                            .foregroundStyle(.orange)
                    } else {
                        Text("Everything else — steps, model, size — stays as this workflow was last run.")
                    }
                }

                Section("How many") {
                    Stepper("\(batch)", value: $batch, in: 1...8)
                }

                Section {
                    Button(action: send) {
                        HStack {
                            Spacer()
                            if sending { ProgressView().controlSize(.small) } else { Text("Generate") }
                            Spacer()
                        }
                    }
                    .disabled(sending || detail == nil || prompt.trimmingCharacters(in: .whitespaces).isEmpty)
                }

                if let note {
                    Section { Text(note).font(.footnote).foregroundStyle(.secondary) }
                }
                if let problem {
                    Section {
                        Label(problem, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                if let job = live.state?.job {
                    Section("Running") { ProgressRow(job: job) }
                }
            }
            .navigationTitle("Generate")
        }
        .task { await loadWorkflows() }
        // The chosen workflow's values are what a render is actually built
        // from, so they are fetched when the choice changes rather than at
        // submit time — where a slow fetch would sit under a tapped button.
        .task(id: chosen?.id) { await loadDetail() }
    }

    private func loadWorkflows() async {
        do {
            // Only the ones switched on: reading a whole ComfyUI installation
            // finds every workflow anybody ever saved, and the picker on a
            // phone is not where you want that list.
            let all = try await client.workflows().filter(\.visible)
            workflows = all
            if chosen == nil { chosen = all.first }
        } catch {
            problem = error.localizedDescription
        }
    }

    private func loadDetail() async {
        guard let chosen else { detail = nil; return }
        do {
            detail = try await client.workflow(chosen.id)
        } catch {
            detail = nil
            problem = error.localizedDescription
        }
    }

    private func send() {
        guard let detail else { return }
        sending = true
        problem = nil
        note = nil

        Task {
            defer { sending = false }
            do {
                let response = try await client.generate(workflow: detail, prompt: prompt, batchCount: batch)
                // A batch can stop part way; the items before it are queued and
                // saying only "failed" would be a lie about those.
                if let error = response.error {
                    problem = error
                } else {
                    note = response.promptIds.count == 1
                        ? "Queued. It will appear in the gallery when it finishes."
                        : "Queued \(response.promptIds.count). They will appear in the gallery as they finish."
                }
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}

/// What the running job is doing, from the live socket.
struct ProgressRow: View {
    let job: LiveJob

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(job.title).font(.subheadline).lineLimit(1)

            // The sampler's own steps when there are any, and the graph's
            // progress when there are not — a workflow spends real time in
            // nodes that report nothing, and a bar stuck at zero through a
            // model load looks like a hang.
            let fraction = job.progressMax > 0
                ? Double(job.progress) / Double(job.progressMax)
                : job.graphProgress
            ProgressView(value: min(max(fraction, 0), 1))

            HStack {
                if let node = job.nodeTitle {
                    Text(node).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                if job.progressMax > 0 {
                    Text("\(job.progress)/\(job.progressMax)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
