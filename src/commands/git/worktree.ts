import { MessageItem, QuickInputButtons, Uri, window } from 'vscode';
import { configuration } from '../../configuration';
import { Container } from '../../container';
import {
	WorktreeCreateError,
	WorktreeCreateErrorReason,
	WorktreeDeleteError,
	WorktreeDeleteErrorReason,
} from '../../git/errors';
import { PremiumFeatures } from '../../git/gitProvider';
import { GitReference, GitWorktree, Repository } from '../../git/models';
import { Messages } from '../../messages';
import { QuickPickItemOfT, QuickPickSeparator } from '../../quickpicks/items/common';
import { Directive } from '../../quickpicks/items/directive';
import { FlagsQuickPickItem } from '../../quickpicks/items/flags';
import { basename, isDescendent } from '../../system/path';
import { pad, pluralize, truncateLeft } from '../../system/string';
import { OpenWorkspaceLocation } from '../../system/utils';
import { ViewsWithRepositoryFolders } from '../../views/viewBase';
import { GitActions } from '../gitCommands.actions';
import {
	appendReposToTitle,
	AsyncStepResultGenerator,
	CustomStep,
	ensureAccessStep,
	inputBranchNameStep,
	PartialStepState,
	pickBranchOrTagStep,
	pickRepositoryStep,
	pickWorktreesStep,
	pickWorktreeStep,
	QuickCommand,
	QuickPickStep,
	StepGenerator,
	StepResult,
	StepResultGenerator,
	StepSelection,
	StepState,
} from '../quickCommand';

interface Context {
	repos: Repository[];
	associatedView: ViewsWithRepositoryFolders;
	defaultUri?: Uri;
	showTags: boolean;
	title: string;
	worktrees?: GitWorktree[];
}

type CreateFlags = '--force' | '-b' | '--detach';

interface CreateState {
	subcommand: 'create';
	repo: string | Repository;
	uri: Uri;
	reference?: GitReference;
	createBranch: string;
	flags: CreateFlags[];
}

type DeleteFlags = '--force';

interface DeleteState {
	subcommand: 'delete';
	repo: string | Repository;
	uris: Uri[];
	flags: DeleteFlags[];
}

type OpenFlags = '--new-window';

interface OpenState {
	subcommand: 'open';
	repo: string | Repository;
	uri: Uri;
	flags: OpenFlags[];
}

type State = CreateState | DeleteState | OpenState;
type WorktreeStepState<T extends State> = SomeNonNullable<StepState<T>, 'subcommand'>;
type CreateStepState<T extends CreateState = CreateState> = WorktreeStepState<ExcludeSome<T, 'repo', string>>;
type DeleteStepState<T extends DeleteState = DeleteState> = WorktreeStepState<ExcludeSome<T, 'repo', string>>;
type OpenStepState<T extends OpenState = OpenState> = WorktreeStepState<ExcludeSome<T, 'repo', string>>;

const subcommandToTitleMap = new Map<State['subcommand'], string>([
	['create', 'Create'],
	['delete', 'Delete'],
	['open', 'Open'],
]);
function getTitle(title: string, subcommand: State['subcommand'] | undefined) {
	return subcommand == null ? title : `${subcommandToTitleMap.get(subcommand)} ${title}`;
}

export interface WorktreeGitCommandArgs {
	readonly command: 'worktree';
	confirm?: boolean;
	state?: Partial<State>;
}

export class WorktreeGitCommand extends QuickCommand<State> {
	private subcommand: State['subcommand'] | undefined;
	private overrideCanConfirm: boolean | undefined;

	constructor(container: Container, args?: WorktreeGitCommandArgs) {
		super(container, 'worktree', 'worktree', 'Worktree', {
			description: 'open, create, or delete worktrees',
		});

		let counter = 0;
		if (args?.state?.subcommand != null) {
			counter++;

			switch (args.state.subcommand) {
				case 'create':
					if (args.state.uri != null) {
						counter++;
					}

					if (args.state.reference != null) {
						counter++;
					}

					break;
				case 'delete':
					if (args.state.uris != null && (!Array.isArray(args.state.uris) || args.state.uris.length !== 0)) {
						counter++;
					}

					break;
				case 'open':
					if (args.state.uri != null) {
						counter++;
					}

					break;
			}
		}

		if (args?.state?.repo != null) {
			counter++;
		}

		this.initialState = {
			counter: counter,
			confirm: args?.confirm,
			...args?.state,
		};
	}

	override get canConfirm(): boolean {
		return this.overrideCanConfirm != null ? this.overrideCanConfirm : this.subcommand != null;
	}

	override get canSkipConfirm(): boolean {
		return false;
	}

	override get skipConfirmKey() {
		return `${this.key}${this.subcommand == null ? '' : `-${this.subcommand}`}:${this.pickedVia}`;
	}

	protected async *steps(state: PartialStepState<State>): StepGenerator {
		const context: Context = {
			repos: Container.instance.git.openRepositories,
			associatedView: Container.instance.worktreesView,
			showTags: false,
			title: this.title,
		};

		let skippedStepTwo = false;

		while (this.canStepsContinue(state)) {
			context.title = this.title;

			if (state.counter < 1 || state.subcommand == null) {
				this.subcommand = undefined;

				const result = yield* this.pickSubcommandStep(state);
				// Always break on the first step (so we will go back)
				if (result === StepResult.Break) break;

				state.subcommand = result;
			}

			this.subcommand = state.subcommand;

			if (state.counter < 2 || state.repo == null || typeof state.repo === 'string') {
				skippedStepTwo = false;
				if (context.repos.length === 1) {
					skippedStepTwo = true;
					state.counter++;

					state.repo = context.repos[0];
				} else {
					const result = yield* pickRepositoryStep(state, context);
					if (result === StepResult.Break) continue;

					state.repo = result;
				}
			}

			const result = yield* ensureAccessStep(state as any, context, PremiumFeatures.Worktrees);
			if (result === StepResult.Break) break;

			context.title = getTitle(state.subcommand === 'delete' ? 'Worktrees' : this.title, state.subcommand);

			switch (state.subcommand) {
				case 'create': {
					yield* this.createCommandSteps(state as CreateStepState, context);
					// Clear any chosen path, since we are exiting this subcommand
					state.uri = undefined;
					break;
				}
				case 'delete': {
					if (state.uris != null && !Array.isArray(state.uris)) {
						state.uris = [state.uris];
					}

					yield* this.deleteCommandSteps(state as DeleteStepState, context);
					break;
				}
				case 'open': {
					yield* this.openCommandSteps(state as OpenStepState, context);
					break;
				}
				default:
					QuickCommand.endSteps(state);
					break;
			}

			// If we skipped the previous step, make sure we back up past it
			if (skippedStepTwo) {
				state.counter--;
			}
		}

		return state.counter < 0 ? StepResult.Break : undefined;
	}

	private *pickSubcommandStep(state: PartialStepState<State>): StepResultGenerator<State['subcommand']> {
		const step = QuickCommand.createPickStep<QuickPickItemOfT<State['subcommand']>>({
			title: this.title,
			placeholder: `Choose a ${this.label} command`,
			items: [
				{
					label: 'open',
					description: 'opens the specified worktree',
					picked: state.subcommand === 'open',
					item: 'open',
				},
				{
					label: 'create',
					description: 'creates a new worktree',
					picked: state.subcommand === 'create',
					item: 'create',
				},
				{
					label: 'delete',
					description: 'deletes the specified worktrees',
					picked: state.subcommand === 'delete',
					item: 'delete',
				},
			],
			buttons: [QuickInputButtons.Back],
		});
		const selection: StepSelection<typeof step> = yield step;
		return QuickCommand.canPickStepContinue(step, state, selection) ? selection[0].item : StepResult.Break;
	}

	private async *createCommandSteps(state: CreateStepState, context: Context): AsyncStepResultGenerator<void> {
		if (context.defaultUri == null) {
			context.defaultUri = await state.repo.getWorktreesDefaultUri();
		}

		if (state.flags == null) {
			state.flags = [];
		}

		while (this.canStepsContinue(state)) {
			this.overrideCanConfirm = undefined;

			if (state.counter < 3 || state.reference == null) {
				const result = yield* pickBranchOrTagStep(state, context, {
					placeholder: context =>
						`Choose a branch${context.showTags ? ' or tag' : ''} to create the new worktree for`,
					picked: state.reference?.ref ?? (await state.repo.getBranch())?.ref,
					titleContext: ' for',
					value: GitReference.isRevision(state.reference) ? state.reference.ref : undefined,
				});
				// Always break on the first step (so we will go back)
				if (result === StepResult.Break) break;

				state.reference = result;
			}

			if (state.counter < 4 || state.uri == null) {
				if (
					state.reference != null &&
					!configuration.get('worktrees.promptForLocation', state.repo.folder) &&
					context.defaultUri != null
				) {
					state.uri = context.defaultUri;
				} else {
					const result = yield* this.createCommandChoosePathStep(state, context, {
						titleContext: ` for ${GitReference.toString(state.reference, {
							capitalize: true,
							icon: false,
							label: state.reference.refType !== 'branch',
						})}`,
					});
					if (result === StepResult.Break) continue;

					state.uri = result;
				}
			}

			// Clear the flags, since we can backup after the confirm step below (which is non-standard)
			state.flags = [];

			// if (this.confirm(state.confirm)) {
			const result = yield* this.createCommandConfirmStep(state, context);
			if (result === StepResult.Break) continue;

			let uri;
			[uri, state.flags] = result;
			// }

			if (state.flags.includes('-b') && state.createBranch == null) {
				this.overrideCanConfirm = false;

				const result = yield* inputBranchNameStep(state, context, {
					placeholder: 'Please provide a name for the new branch',
					titleContext: ` from ${GitReference.toString(state.reference, {
						capitalize: true,
						icon: false,
						label: state.reference.refType !== 'branch',
					})}`,
					value: state.createBranch ?? GitReference.getNameWithoutRemote(state.reference),
				});
				if (result === StepResult.Break) continue;

				state.createBranch = result;
				uri = Uri.joinPath(uri, state.createBranch);
			}

			QuickCommand.endSteps(state);

			const friendlyPath = GitWorktree.getFriendlyPath(uri);

			let retry = false;
			do {
				retry = false;
				const force = state.flags.includes('--force');

				try {
					await state.repo.createWorktree(uri, {
						commitish: state.reference?.name,
						createBranch: state.flags.includes('-b') ? state.createBranch : undefined,
						detach: state.flags.includes('--detach'),
						force: force,
					});
				} catch (ex) {
					if (
						!force &&
						ex instanceof WorktreeCreateError &&
						ex.reason === WorktreeCreateErrorReason.AlreadyCheckedOut
					) {
						const confirm: MessageItem = { title: 'Create Anyway' };
						const cancel: MessageItem = { title: 'Cancel', isCloseAffordance: true };
						const result = await window.showWarningMessage(
							`Unable to create a new worktree in '${friendlyPath}' because ${GitReference.toString(
								state.reference,
								{ icon: false, quoted: true },
							)} is already checked out.\n\nWould you like to create this worktree anyway?`,
							{ modal: true },
							confirm,
							cancel,
						);

						if (result === confirm) {
							state.flags.push('--force');
							retry = true;
						}
					} else if (
						ex instanceof WorktreeCreateError &&
						ex.reason === WorktreeCreateErrorReason.AlreadyExists
					) {
						void Messages.showGenericErrorMessage(
							`Unable to create a new worktree in '${friendlyPath} because that folder already exists.`,
						);
					} else {
						void Messages.showGenericErrorMessage(`Unable to create a new worktree in '${friendlyPath}.`);
					}
				}
			} while (retry);
		}
	}

	private async *createCommandChoosePathStep(
		state: CreateStepState,
		context: Context,
		options?: { titleContext?: string },
	): AsyncStepResultGenerator<Uri> {
		const step = QuickCommand.createCustomStep<Uri>({
			show: async (_step: CustomStep<Uri>) => {
				const uris = await window.showOpenDialog({
					canSelectFiles: false,
					canSelectFolders: true,
					canSelectMany: false,
					defaultUri: state.uri ?? context.defaultUri,
					openLabel: 'Select Worktree Location',
					title: `${appendReposToTitle(
						`Choose Worktree Location${options?.titleContext ?? ''}`,
						state,
						context,
					)}`,
				});

				if (uris == null || uris.length === 0) return Directive.Back;

				return uris[0];
			},
		});

		const value: StepSelection<typeof step> = yield step;

		if (
			!QuickCommand.canStepContinue(step, state, value) ||
			!(await QuickCommand.canInputStepContinue(step, state, value))
		) {
			return StepResult.Break;
		}

		return value;
	}

	private *createCommandConfirmStep(
		state: CreateStepState,
		context: Context,
	): StepResultGenerator<[Uri, CreateFlags[]]> {
		const chosenUri = state.uri;
		const chosenFriendlyPath = truncateLeft(GitWorktree.getFriendlyPath(chosenUri), 60);

		let allowCreateInRoot = true;
		let chosenWithRepoSubfoldersUri = chosenUri;

		const folderUri = state.repo.folder?.uri;
		if (folderUri != null) {
			if (folderUri.toString() !== chosenUri.toString()) {
				const descendent = isDescendent(chosenUri, folderUri);
				if (!descendent) {
					chosenWithRepoSubfoldersUri = Uri.joinPath(chosenUri, basename(folderUri.path));
				}
			} else {
				allowCreateInRoot = false;
			}
		}

		let chosenWithRepoAndRefSubfoldersUri;
		let chosenWithRepoAndRefSubfoldersFriendlyPath: string = undefined!;

		if (state.reference != null) {
			chosenWithRepoAndRefSubfoldersUri = Uri.joinPath(
				chosenWithRepoSubfoldersUri ?? chosenUri,
				...state.reference.name.replace(/\\/g, '/').split('/'),
			);
			chosenWithRepoAndRefSubfoldersFriendlyPath = truncateLeft(
				GitWorktree.getFriendlyPath(chosenWithRepoAndRefSubfoldersUri),
				65,
			);
		}

		const chosenWithRepoAndNewRefSubfoldersUri = Uri.joinPath(
			chosenWithRepoSubfoldersUri ?? chosenUri,
			'<new-branch-name>',
		);
		const chosenWithRepoAndNewRefSubfoldersFriendlyPath = truncateLeft(
			GitWorktree.getFriendlyPath(chosenWithRepoAndNewRefSubfoldersUri),
			58,
		);

		const step: QuickPickStep<FlagsQuickPickItem<CreateFlags, Uri>> = QuickCommand.createConfirmStep(
			appendReposToTitle(`Confirm ${context.title}`, state, context),
			[
				...(chosenWithRepoAndRefSubfoldersUri != null
					? [
							FlagsQuickPickItem.create<CreateFlags, Uri>(
								state.flags,
								[],
								{
									label: context.title,
									description: ` for ${GitReference.toString(state.reference)}`,
									detail: `Will create worktree in${pad(
										'$(folder)',
										2,
										2,
									)}${chosenWithRepoAndRefSubfoldersFriendlyPath}`,
								},
								chosenWithRepoAndRefSubfoldersUri,
							),
					  ]
					: []),
				...(chosenWithRepoSubfoldersUri != null
					? [
							FlagsQuickPickItem.create<CreateFlags, Uri>(
								state.flags,
								['-b'],
								{
									label: 'Create New Branch and Worktree',
									description: ` from ${GitReference.toString(state.reference)}`,
									detail: `Will create worktree in${pad(
										'$(folder)',
										2,
										2,
									)}${chosenWithRepoAndNewRefSubfoldersFriendlyPath}`,
								},
								chosenWithRepoSubfoldersUri,
							),
					  ]
					: []),
				QuickPickSeparator.create(),
				...(allowCreateInRoot
					? [
							FlagsQuickPickItem.create<CreateFlags, Uri>(
								state.flags,
								[],
								{
									label: `${context.title} (directly in folder)`,
									description: ` for ${GitReference.toString(state.reference)}`,
									detail: `Will create worktree directly in${pad(
										'$(folder)',
										2,
										2,
									)}${chosenFriendlyPath}`,
								},
								chosenUri,
							),
					  ]
					: []),
				...(allowCreateInRoot
					? [
							FlagsQuickPickItem.create<CreateFlags, Uri>(
								state.flags,
								['-b'],
								{
									label: 'Create New Branch and Worktree (directly in folder)',
									description: ` from ${GitReference.toString(state.reference)}`,
									detail: `Will create worktree directly in${pad(
										'$(folder)',
										2,
										2,
									)}${chosenWithRepoAndNewRefSubfoldersFriendlyPath}`,
								},
								chosenUri,
							),
					  ]
					: []),
			] as FlagsQuickPickItem<CreateFlags, Uri>[],
			context,
		);
		const selection: StepSelection<typeof step> = yield step;
		return QuickCommand.canPickStepContinue(step, state, selection)
			? [selection[0].context, selection[0].item]
			: StepResult.Break;
	}

	private async *deleteCommandSteps(state: DeleteStepState, context: Context): StepGenerator {
		context.worktrees = await state.repo.getWorktrees();

		if (state.flags == null) {
			state.flags = [];
		}

		while (this.canStepsContinue(state)) {
			if (state.counter < 3 || state.uris == null || state.uris.length === 0) {
				context.title = getTitle('Worktrees', state.subcommand);

				const result = yield* pickWorktreesStep(state, context, {
					filter: wt => !wt.opened, // Can't delete an open worktree
					includeStatus: true,
					picked: state.uris?.map(uri => uri.toString()),
					placeholder: 'Choose worktrees to delete',
				});
				// Always break on the first step (so we will go back)
				if (result === StepResult.Break) break;

				state.uris = result.map(w => w.uri);
			}

			context.title = getTitle(pluralize('Worktree', state.uris.length, { only: true }), state.subcommand);

			const result = yield* this.deleteCommandConfirmStep(state, context);
			if (result === StepResult.Break) continue;

			state.flags = result;

			QuickCommand.endSteps(state);

			for (const uri of state.uris) {
				let retry = false;
				do {
					retry = false;
					const force = state.flags.includes('--force');

					try {
						if (force) {
							const worktree = context.worktrees.find(wt => wt.uri.toString() === uri.toString());
							const status = await worktree?.getStatus();
							if (status?.hasChanges ?? false) {
								const confirm: MessageItem = { title: 'Force Delete' };
								const cancel: MessageItem = { title: 'Cancel', isCloseAffordance: true };
								const result = await window.showWarningMessage(
									`The worktree in '${uri.fsPath}' has uncommitted changes.\n\nDeleting it will cause those changes to be FOREVER LOST.\nThis is IRREVERSIBLE!\n\nAre you sure you still want to delete it?`,
									{ modal: true },
									confirm,
									cancel,
								);

								if (result !== confirm) return;
							}
						}

						await state.repo.deleteWorktree(uri, { force: force });
					} catch (ex) {
						if (ex instanceof WorktreeDeleteError) {
							if (ex.reason === WorktreeDeleteErrorReason.MainWorkingTree) {
								void window.showErrorMessage('Unable to delete the main worktree');
							} else if (!force) {
								const confirm: MessageItem = { title: 'Force Delete' };
								const cancel: MessageItem = { title: 'Cancel', isCloseAffordance: true };
								const result = await window.showErrorMessage(
									ex.reason === WorktreeDeleteErrorReason.HasChanges
										? `Unable to delete worktree because there are UNCOMMITTED changes in '${uri.fsPath}'.\n\nForcibly deleting it will cause those changes to be FOREVER LOST.\nThis is IRREVERSIBLE!\n\nWould you like to forcibly delete it?`
										: `Unable to delete worktree in '${uri.fsPath}'.\n\nWould you like to try to forcibly delete it?`,
									{ modal: true },
									confirm,
									cancel,
								);

								if (result === confirm) {
									state.flags.push('--force');
									retry = true;
								}
							}
						} else {
							void Messages.showGenericErrorMessage(`Unable to delete worktree in '${uri.fsPath}.`);
						}
					}
				} while (retry);
			}
		}
	}

	private *deleteCommandConfirmStep(state: DeleteStepState, context: Context): StepResultGenerator<DeleteFlags[]> {
		const step: QuickPickStep<FlagsQuickPickItem<DeleteFlags>> = QuickCommand.createConfirmStep(
			appendReposToTitle(`Confirm ${context.title}`, state, context),
			[
				FlagsQuickPickItem.create<DeleteFlags>(state.flags, [], {
					label: context.title,
					detail: `Will delete ${pluralize('worktree', state.uris.length, {
						only: state.uris.length === 1,
					})}${
						state.uris.length === 1
							? ` in${pad('$(folder)', 2, 2)}${GitWorktree.getFriendlyPath(state.uris[0])}`
							: ''
					}`,
				}),
				FlagsQuickPickItem.create<DeleteFlags>(state.flags, ['--force'], {
					label: `Force ${context.title}`,
					detail: `Will forcibly delete ${pluralize('worktree', state.uris.length, {
						only: state.uris.length === 1,
					})} even with UNCOMMITTED changes${
						state.uris.length === 1
							? ` in${pad('$(folder)', 2, 2)}${GitWorktree.getFriendlyPath(state.uris[0])}`
							: ''
					}`,
				}),
			],
			context,
		);

		const selection: StepSelection<typeof step> = yield step;
		return QuickCommand.canPickStepContinue(step, state, selection) ? selection[0].item : StepResult.Break;
	}

	private async *openCommandSteps(state: OpenStepState, context: Context): StepGenerator {
		context.worktrees = await state.repo.getWorktrees();

		if (state.flags == null) {
			state.flags = [];
		}

		while (this.canStepsContinue(state)) {
			if (state.counter < 3 || state.uri == null) {
				context.title = getTitle('Worktree', state.subcommand);

				const result = yield* pickWorktreeStep(state, context, {
					includeStatus: true,
					picked: state.uri?.toString(),
					placeholder: 'Choose worktree to open',
				});
				// Always break on the first step (so we will go back)
				if (result === StepResult.Break) break;

				state.uri = result.uri;
			}

			context.title = getTitle('Worktree', state.subcommand);

			const result = yield* this.openCommandConfirmStep(state, context);
			if (result === StepResult.Break) continue;

			state.flags = result;

			QuickCommand.endSteps(state);

			const worktree = context.worktrees.find(wt => wt.uri.toString() === state.uri.toString())!;
			GitActions.Worktree.open(worktree, {
				location: state.flags.includes('--new-window')
					? OpenWorkspaceLocation.NewWindow
					: OpenWorkspaceLocation.CurrentWindow,
			});
		}
	}

	private *openCommandConfirmStep(state: OpenStepState, context: Context): StepResultGenerator<OpenFlags[]> {
		const step: QuickPickStep<FlagsQuickPickItem<OpenFlags>> = QuickCommand.createConfirmStep(
			appendReposToTitle(`Confirm ${context.title}`, state, context),
			[
				FlagsQuickPickItem.create<OpenFlags>(state.flags, [], {
					label: context.title,
					detail: `Will open the worktree in ${GitWorktree.getFriendlyPath(state.uri)} in the current window`,
				}),
				FlagsQuickPickItem.create<OpenFlags>(state.flags, ['--new-window'], {
					label: `${context.title} in New Window`,
					detail: `Will open the worktree in ${GitWorktree.getFriendlyPath(state.uri)} in a new window`,
				}),
			],
			context,
		);

		const selection: StepSelection<typeof step> = yield step;
		return QuickCommand.canPickStepContinue(step, state, selection) ? selection[0].item : StepResult.Break;
	}
}