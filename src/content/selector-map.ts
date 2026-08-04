/**
 * The single versioned selector map.
 *
 * Every DOM selector and UI heuristic in this extension lives here. Business
 * logic and action executors reference specs by key and never contain a raw
 * selector, so a Canva redesign is a change to this one file.
 *
 * Strategy order inside each spec matters: earlier candidates are preferred.
 * Role, `aria-*` and stable visible text come first because they survive Canva's
 * CSS churn; hashed class names are a last resort and are deliberately absent.
 *
 * Text candidates are English-first. Canva localises its interface, so a user on
 * a non-English locale should expect `selector_not_found` and fall back to
 * manual assist. That trade-off is documented in the README.
 */

export const SELECTOR_MAP_VERSION = '2026-08-04.1';

export type SelectorStrategy = 'css' | 'testId' | 'role' | 'label' | 'text';

export interface SelectorCandidate {
  /** Shown in selector diagnostics so a failure is traceable to a candidate. */
  description: string;
  strategy: SelectorStrategy;
  /**
   * `css`: a CSS selector.
   * `testId`: the test-id attribute value.
   * `role`: an ARIA role name.
   * `label`: matched against `aria-label` / accessible name.
   * `text`: matched against visible text, scoped by `within`.
   */
  value?: string;
  /** Accessible name or visible text to match. Any entry matching is enough. */
  name?: readonly string[];
  /** Element scope for `text` / `label` strategies. */
  within?: string;
  /** Require the whole name to match rather than a substring. */
  exact?: boolean;
  /** Skip elements that are not rendered. Default true. */
  requireVisible?: boolean;
}

export interface SelectorSpec {
  key: string;
  /** What this control is for, in operator language. */
  purpose: string;
  candidates: readonly SelectorCandidate[];
}

function spec(key: string, purpose: string, candidates: readonly SelectorCandidate[]): SelectorSpec {
  return { key, purpose, candidates };
}

/* Shared vocabularies, so wording variants are declared once. */

const CLICKABLE_SCOPE = 'button, a, [role="button"], [role="menuitem"], [role="option"], [tabindex]';

const COPY_TO_TEAM_NAMES = [
  'copy to another team',
  'copy to team',
  'copy to another account',
  'copy to',
  'make a copy to',
] as const;

const TRASH_NAMES = ['move to trash', 'move to bin', 'delete', 'remove'] as const;

const LEAVE_TEAM_NAMES = ['leave team', 'leave this team', 'leave'] as const;

export const SELECTORS = {
  /* ------------------------------------------------------------ workspace --- */

  workspaceSwitcherTrigger: spec(
    'workspaceSwitcherTrigger',
    'Opens the list of teams and personal spaces the session can switch into',
    [
      { description: 'Team switcher button by accessible name', strategy: 'label', name: ['switch team', 'team switcher', 'switch workspace', 'your teams'] },
      { description: 'Header button whose text is the current workspace', strategy: 'testId', value: 'team-switcher' },
      { description: 'Nav control mentioning teams', strategy: 'text', name: ['switch team', 'your teams'], within: CLICKABLE_SCOPE },
    ],
  ),

  workspaceSwitcherMenu: spec('workspaceSwitcherMenu', 'The open workspace switcher surface', [
    { description: 'Menu or listbox role', strategy: 'role', value: 'menu' },
    { description: 'Listbox role', strategy: 'role', value: 'listbox' },
    { description: 'Dialog role fallback', strategy: 'role', value: 'dialog' },
  ]),

  workspaceOption: spec('workspaceOption', 'A single selectable workspace inside the switcher', [
    { description: 'Menu item inside the switcher', strategy: 'role', value: 'menuitem' },
    { description: 'Option role inside the switcher', strategy: 'role', value: 'option' },
    { description: 'Link or button inside the switcher surface', strategy: 'css', value: 'a[href], button' },
  ]),

  currentWorkspaceLabel: spec('currentWorkspaceLabel', 'Name of the workspace the session is currently in', [
    { description: 'Element flagged as the current team', strategy: 'css', value: '[aria-current="true"], [aria-selected="true"]' },
    { description: 'Switcher trigger text', strategy: 'testId', value: 'team-switcher' },
  ]),

  /* --------------------------------------------------------- project list --- */

  projectGrid: spec('projectGrid', 'Container holding the design cards', [
    { description: 'Grid role', strategy: 'role', value: 'grid' },
    { description: 'List role', strategy: 'role', value: 'list' },
    { description: 'Main region', strategy: 'role', value: 'main' },
  ]),

  projectItemCard: spec('projectItemCard', 'One design card in the listing', [
    { description: 'Grid cell', strategy: 'role', value: 'gridcell' },
    { description: 'List item', strategy: 'role', value: 'listitem' },
    { description: 'Anchor to a design', strategy: 'css', value: 'a[href*="/design/"]' },
  ]),

  projectItemTitle: spec('projectItemTitle', 'Title text inside a design card', [
    { description: 'Heading inside the card', strategy: 'css', value: '[role="heading"], h2, h3, h4' },
    { description: 'Anchor title attribute', strategy: 'css', value: 'a[href*="/design/"][title], [title]' },
    { description: 'Aria label on the card link', strategy: 'css', value: 'a[href*="/design/"][aria-label]' },
  ]),

  projectItemLink: spec('projectItemLink', 'Link to open the design', [
    { description: 'Design anchor', strategy: 'css', value: 'a[href*="/design/"]' },
  ]),

  projectItemOwnerLabel: spec('projectItemOwnerLabel', 'Owner or author text shown on the card', [
    { description: 'Explicit owner test id', strategy: 'testId', value: 'owner-name' },
    { description: 'Text mentioning the owner', strategy: 'text', name: ['owned by', 'created by', 'by you', 'you'], within: 'span, div, p' },
  ]),

  projectItemMenuTrigger: spec('projectItemMenuTrigger', 'The card overflow (…) button that opens item actions', [
    { description: 'Accessible name for a card action menu', strategy: 'label', name: ['more actions', 'more options', 'options', 'actions', 'menu'] },
    { description: 'Button with popup semantics inside the card', strategy: 'css', value: 'button[aria-haspopup], [role="button"][aria-haspopup]' },
    { description: 'Any button inside the card', strategy: 'css', value: 'button' },
  ]),

  listScrollSentinel: spec('listScrollSentinel', 'Element at the end of the list used to trigger lazy loading', [
    { description: 'Explicit load-more control', strategy: 'text', name: ['load more', 'show more'], within: CLICKABLE_SCOPE },
    { description: 'Progress indicator at the end of the list', strategy: 'role', value: 'progressbar' },
  ]),

  /* ----------------------------------------------------------- item menu --- */

  itemMenu: spec('itemMenu', 'The open item action menu', [
    { description: 'Menu role', strategy: 'role', value: 'menu' },
    { description: 'Popper surface', strategy: 'css', value: '[data-radix-popper-content-wrapper], [role="dialog"]' },
  ]),

  /*
   * These two are always resolved with the open menu as the root, so `within`
   * only needs to list clickable descendants. Prefixing a menu scope here would
   * be wrong: in CSS, commas bind looser than the descendant combinator.
   */
  itemMenuCopyToTeam: spec('itemMenuCopyToTeam', 'The "copy to another team" entry in the item menu', [
    { description: 'Menu entry by visible text', strategy: 'text', name: COPY_TO_TEAM_NAMES, within: CLICKABLE_SCOPE },
    { description: 'Menu entry by accessible name', strategy: 'label', name: COPY_TO_TEAM_NAMES },
    { description: 'Any menu entry mentioning copy', strategy: 'text', name: ['copy'], within: '[role="menuitem"]' },
  ]),

  itemMenuMoveToTrash: spec('itemMenuMoveToTrash', 'The move-to-trash entry in the item menu', [
    { description: 'Menu entry by visible text', strategy: 'text', name: TRASH_NAMES, within: CLICKABLE_SCOPE },
    { description: 'Menu entry by accessible name', strategy: 'label', name: TRASH_NAMES },
  ]),

  /* --------------------------------------------------------- copy dialog --- */

  copyDialog: spec('copyDialog', 'The destination picker shown after choosing copy', [
    { description: 'Modal dialog', strategy: 'role', value: 'dialog' },
    { description: 'Alert dialog', strategy: 'role', value: 'alertdialog' },
  ]),

  copyDialogSearchInput: spec('copyDialogSearchInput', 'Search field for finding the destination workspace', [
    { description: 'Search box role', strategy: 'role', value: 'searchbox' },
    { description: 'Text input inside the dialog', strategy: 'css', value: 'input[type="text"], input[type="search"], input:not([type])' },
  ]),

  copyDialogDestinationOption: spec('copyDialogDestinationOption', 'A destination workspace row inside the copy dialog', [
    { description: 'Option role', strategy: 'role', value: 'option' },
    { description: 'Radio role', strategy: 'role', value: 'radio' },
    { description: 'Menu item role', strategy: 'role', value: 'menuitem' },
    { description: 'Button or label row', strategy: 'css', value: 'button, label, li' },
  ]),

  copyDialogConfirm: spec('copyDialogConfirm', 'The button that performs the copy', [
    { description: 'Primary confirm text', strategy: 'text', name: ['copy', 'copy design', 'copy here', 'done', 'confirm'], within: 'button, [role="button"]' },
    { description: 'Submit button inside the dialog', strategy: 'css', value: 'button[type="submit"]' },
  ]),

  copyDialogCancel: spec('copyDialogCancel', 'The button that dismisses the copy dialog', [
    { description: 'Cancel text', strategy: 'text', name: ['cancel', 'close'], within: 'button, [role="button"]' },
    { description: 'Close by accessible name', strategy: 'label', name: ['close', 'cancel'] },
  ]),

  /* -------------------------------------------------------- confirmations --- */

  confirmDialog: spec('confirmDialog', 'A generic Canva confirmation dialog', [
    { description: 'Alert dialog', strategy: 'role', value: 'alertdialog' },
    { description: 'Dialog', strategy: 'role', value: 'dialog' },
  ]),

  confirmDialogTrashButton: spec('confirmDialogTrashButton', 'The confirm control in the trash confirmation dialog', [
    { description: 'Confirm text', strategy: 'text', name: ['move to trash', 'move to bin', 'delete', 'confirm', 'yes'], within: 'button, [role="button"]' },
  ]),

  successToast: spec('successToast', 'Canva success notification', [
    { description: 'Status live region', strategy: 'role', value: 'status' },
    { description: 'Alert live region', strategy: 'role', value: 'alert' },
    { description: 'Aria-live container', strategy: 'css', value: '[aria-live="polite"], [aria-live="assertive"]' },
  ]),

  /* ------------------------------------------------------------ team exit --- */

  teamSettingsLeaveControl: spec('teamSettingsLeaveControl', 'The control that starts leaving the team', [
    { description: 'Leave by visible text', strategy: 'text', name: LEAVE_TEAM_NAMES, within: CLICKABLE_SCOPE },
    { description: 'Leave by accessible name', strategy: 'label', name: LEAVE_TEAM_NAMES },
  ]),

  teamLeaveConfirmButton: spec('teamLeaveConfirmButton', 'The confirm control in the leave-team dialog', [
    { description: 'Confirm text inside a dialog', strategy: 'text', name: ['leave team', 'leave', 'confirm', 'yes'], within: 'button, [role="button"]' },
  ]),

  teamLeaveBlockedNotice: spec('teamLeaveBlockedNotice', 'Message explaining that leaving is not permitted', [
    {
      description: 'Policy text',
      strategy: 'text',
      name: [
        'cannot leave',
        "can't leave",
        'not allowed to leave',
        'contact your team admin',
        'only owner',
        'transfer ownership',
      ],
      within: 'p, span, div, [role="alert"], [role="dialog"]',
    },
  ]),

  /* ------------------------------------------------------- interruptions --- */

  authWall: spec('authWall', 'Sign-in or re-authentication screen', [
    { description: 'Password field', strategy: 'css', value: 'input[type="password"]' },
    { description: 'Sign-in call to action', strategy: 'text', name: ['log in', 'sign in', 'continue to log in'], within: 'button, [role="button"], h1, h2' },
    { description: 'Session expiry copy', strategy: 'text', name: ['session has expired', 'please log in again', 'verify your identity'], within: 'p, span, div, h1, h2' },
  ]),

  captchaWall: spec('captchaWall', 'CAPTCHA or abuse-prevention screen', [
    { description: 'Recaptcha or hcaptcha frame', strategy: 'css', value: 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[title*="captcha" i]' },
    { description: 'Challenge container', strategy: 'css', value: '#challenge-running, [data-testid="captcha"], [class*="captcha" i]' },
    {
      description: 'Rate-limit copy',
      strategy: 'text',
      name: ['unusual activity', 'too many requests', 'are you a robot', 'verify you are human', 'slow down'],
      within: 'p, span, div, h1, h2',
    },
  ]),

  /* ----------------------------------------------------------- app shell --- */

  appShell: spec('appShell', 'Evidence that the Canva web app shell rendered', [
    { description: 'Application main region', strategy: 'role', value: 'main' },
    { description: 'Navigation region', strategy: 'role', value: 'navigation' },
    { description: 'App root', strategy: 'css', value: '#root, #app, [data-reactroot]' },
  ]),

  accountMenuTrigger: spec('accountMenuTrigger', 'Account avatar button, used as a logged-in signal', [
    { description: 'Account by accessible name', strategy: 'label', name: ['account', 'profile', 'your account', 'settings'] },
    { description: 'Avatar image', strategy: 'css', value: 'img[alt*="avatar" i], img[alt*="profile" i]' },
  ]),
} as const satisfies Record<string, SelectorSpec>;

export type SelectorKey = keyof typeof SELECTORS;

/** Documented assumptions, surfaced in the Options diagnostics panel. */
export const SELECTOR_MAP_NOTES: readonly string[] = [
  'Canva does not publish a stable DOM contract. Every candidate here is a heuristic that may need updating.',
  'Role and aria-label candidates are tried before visible text; hashed CSS class names are never used.',
  'Visible-text candidates assume the Canva interface is in English.',
  'Copy is performed through Canva\'s own "copy to another team" flow, one item at a time.',
  'Trash means Canva\'s move-to-trash action. Permanent deletion is not automated.',
  'Leaving a team uses the visible control in Canva settings and can be blocked by team admins.',
];
