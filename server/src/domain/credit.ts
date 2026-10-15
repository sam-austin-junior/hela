// Credit-building checklist (Kenya). A rule engine decides what goes on the
// list; the model only explains it. Hela never computes or promises a score.

export interface CreditAnswers {
  studentLoan: 'none' | 'current' | 'in_arrears';
  mobileLoans: 'none' | 'repaid_on_time' | 'late';
  missedPayments12m: number;
  hasBankAccount: boolean;
  checkedCrbReport12m: boolean;
}

export interface ChecklistItem {
  id: string;
  priority: 1 | 2 | 3; // 1 = do first
  title: string;
  why: string;
}

export function creditChecklist(a: CreditAnswers): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  if (a.studentLoan === 'in_arrears') {
    items.push({
      id: 'clear-loan-arrears',
      priority: 1,
      title: 'Agree a repayment plan for your student loan arrears',
      why: 'Loans in arrears are reported to credit bureaus and weigh most on lenders\' decisions.',
    });
  }
  if (a.mobileLoans === 'late' || a.missedPayments12m > 0) {
    items.push({
      id: 'stop-late-payments',
      priority: 1,
      title: 'Set reminders or scheduled payments so nothing is paid late',
      why: 'Recent late payments are the most common reason for a poor bureau record.',
    });
  }
  if (!a.checkedCrbReport12m) {
    items.push({
      id: 'check-crb-report',
      priority: a.missedPayments12m > 0 ? 1 : 2,
      title: 'Request your free credit report from a licensed credit bureau',
      why: 'You can dispute wrong entries, and you will know what lenders see.',
    });
  }
  if (!a.hasBankAccount) {
    items.push({
      id: 'open-bank-account',
      priority: 2,
      title: 'Open a student bank account and receive your income through it',
      why: 'Regular deposits build a record that banks can use when you apply for credit.',
    });
  }
  if (a.studentLoan === 'current') {
    items.push({
      id: 'keep-loan-current',
      priority: 2,
      title: 'Keep your student loan up to date',
      why: 'A loan paid on time is positive history.',
    });
  }
  if (a.mobileLoans === 'repaid_on_time') {
    items.push({
      id: 'limit-mobile-loans',
      priority: 3,
      title: 'Borrow on mobile loans only when needed, and keep repaying on time',
      why: 'Many small loans in a short time can look like financial stress.',
    });
  }
  items.push({
    id: 'keep-utilisation-low',
    priority: 3,
    title: 'Keep any overdraft or credit use well below its limit',
    why: 'Using a small share of the credit available reads as careful borrowing.',
  });

  return items.sort((x, y) => x.priority - y.priority);
}
