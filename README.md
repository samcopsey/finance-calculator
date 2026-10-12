# Personal Finance Calculator

A UK personal and household finance calculator that runs entirely on your own device. Work out your take-home pay, build a budget, compare savings strategies, model a mortgage down to the first payment, plan the cash you need to buy a home, and project your finances forward — without handing your data to anyone.

- **Private by design** — no accounts, no server, no analytics. Every calculation happens in your browser.
- **Built and run by you** — clone it, install it and run it on your own machine with Node.js.
- **Made for the UK** — income tax, National Insurance and student loan rules for the 2026/27 tax year, plus Stamp Duty Land Tax.

> **Not financial advice.** This is a modelling tool and its figures are estimates. Check anything important with HMRC, your lender or a regulated financial adviser.

## Features

| Tab | What it does |
| --- | --- |
| **Overview** | Take-home pay for one person or a two-person household: income tax (including the personal allowance taper), employee National Insurance, pension contributions, student loan Plans 1 and 2, and PAYE or self-employed income with an estimated Self Assessment bill. Monthly expenses with your own line items, split between two people by share of take-home pay or a custom percentage. |
| **Savings Models** | Compare your spending against the 50/30/20, 70/20/10 and Pay Yourself First approaches. |
| **Mortgage** | Repayment mortgages with payments collected in advance (as some lenders illustrate them) or in arrears, interest from completion in the first payment, a product fee paid upfront or added to the loan, a fixed-rate end date and follow-on rate, manual overrides to match a mortgage illustration, monthly and annual overpayments, loan-to-value, an affordability check, stamp duty with first-time buyer relief, and a yearly amortisation chart. |
| **Purchase Plan** | Itemise the cost of buying a home — essentials and extras, one-off costs paid upfront and yearly costs paid annually or monthly — and see how much your chosen savings pots cover, the gap that remains and when monthly saving should close it. |
| **Savings & Investments** | Any number of pots (current accounts, savings, ISAs, Lifetime ISAs, investments, pensions and employee share schemes), each owned by one person or held jointly, with its own rate and compounding. Contributions can be marked as salary sacrifice so they come out of pay before tax and NI. Growth projections up to 40 years. |
| **Finance Agreements** | Loans and finance agreements with monthly payments and total interest. |
| **Projections** | A 12- or 24-month projection with salary growth and inflation, a house deposit tracker and an "if you completed today" scenario. |
| **Expense Log** | A simple record of actual spending by category. |
| **Report** | A print-friendly summary of income, spending, savings, the mortgage, the purchase plan and projections. |

## Your data stays on your device

- The app is a static web page. It has no backend, accounts, cookies or analytics, and it doesn't send your data anywhere.
- Nothing is saved automatically. If you close the tab, your inputs are gone.
- **Save Data** downloads your inputs as a JSON file (`finances-YYYY-MM-DD.json`) and **Load Data** restores one. These files hold your financial details in plain text, so keep them somewhere private.
- The project's `.gitignore` excludes the app's save files (`finances*.json`) and common bank-statement exports (CSV, PDF, spreadsheets, OFX and QIF) in any letter case, so they're hard to commit by accident. Still check `git status` before you commit.
- `npm start` and `npm run dev` only listen on `localhost`, so the app isn't reachable from other devices on your network.

## Getting started

You'll need [Node.js](https://nodejs.org/) 22.12 or later (the current LTS release is recommended) and npm, which comes with Node.js.

```bash
git clone https://github.com/samcopsey/finance-calculator.git
cd finance-calculator
npm install
npm start
```

`npm start` builds the app and opens it in your browser at <http://localhost:4173> (if that port is busy, Vite uses the next free one and shows the address in the terminal). Press <kbd>Ctrl</kbd>+<kbd>C</kbd> in the terminal to stop it. Next time, run `npm start` again — there's no need to reinstall.

No git? Download the ZIP from GitHub (**Code → Download ZIP**), unzip it and run `npm install` and `npm start` inside the folder.

### Other commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with hot reload at <http://localhost:5173> |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the existing `dist/` build at <http://localhost:4173> |
| `npm run lint` | Check the code with ESLint |

To serve the build another way, serve the `dist` folder itself as the site root (for example `python3 -m http.server --directory dist`). Opening `dist/index.html` straight from disk won't work, because the build loads its JavaScript from absolute `/assets/` paths as ES modules.

## Using the app

1. Choose **Single Person** or **Household** at the top.
2. Enter income and monthly expenses on **Overview**.
3. Add your savings and investments as pots on **Savings & Investments**. Current accounts, savings, ISAs and Lifetime ISAs start with **Purchase** ticked, so untick any pot you won't use to buy a home.
4. Fill in **Mortgage** (the Lender Deal section matches the calculation to a mortgage illustration), then list your buying costs on **Purchase Plan**.
5. Check **Projections**, then print the **Report**.
6. Click **Save Data** before you close the tab.

To explore with made-up figures, click **Load Data** and choose [`examples/example-household.json`](examples/example-household.json) — a fictional two-person household saving for a first home.

## Assumptions and limitations

- **Tax year.** Rates and thresholds are for the 2026/27 tax year (6 April 2026 to 5 April 2027), checked against gov.uk in October 2026. They're hard-coded at the top of `src/App.jsx` and won't update themselves.
- **Income tax** uses the bands for England, Wales and Northern Ireland. Scottish income tax isn't modelled.
- **National Insurance** is Class 1 for employees on PAYE income and Class 4 on self-employed profits. Class 2 isn't included, as it has been voluntary since April 2024. All PAYE income is treated as one job, so NI on a second job (which has its own threshold) may be overstated.
- **Student loans** cover Plans 1 and 2 only. Plan 4 (Scotland), Plan 5 and Postgraduate Loans aren't modelled.
- **Pension contributions** are a percentage of salary taken before income tax, NI and student loan repayments, as with salary sacrifice. With a net pay arrangement or relief at source, NI and student loan repayments are worked out on your full salary, and with relief at source any higher-rate relief is claimed back through Self Assessment, so take-home pay here may be higher than on your payslip.
- **Stamp duty** is Stamp Duty Land Tax for England and Northern Ireland: standard residential rates plus first-time buyer relief. Scotland's LBTT, Wales's LTT, the higher rates for additional properties and the non-resident surcharge aren't modelled.
- **Mortgages** are capital repayment only. When a fixed rate ends, the new payment is worked out from the balance you'd have without overpayments, and overpayments keep shortening the term. Lenders usually recalculate from your actual balance instead.
- **Savings and investments** grow at the rate and compounding you choose for each pot. Fees, tax on interest and dividends, and the Lifetime ISA rules (the government bonus, the £450,000 first-home limit and the withdrawal charge) aren't modelled.
- **Projections** are simple and deterministic: salary growth is applied to take-home pay without recalculating tax, inflation applies to monthly living costs only (yearly costs paid annually stay flat), and there's no allowance for market ups and downs.

## Project structure

```
src/App.jsx      The whole app: tax and mortgage logic at the top, then one React component with a block per tab
src/main.jsx     React entry point
src/index.css    CSS reset and print styles
public/          Favicon
examples/        A fictional save file for trying the app
```

Built with [React](https://react.dev/) 19, [Vite](https://vite.dev/) 8 and [Recharts](https://recharts.org/) 3. There's no backend, router, state library, CSS framework or TypeScript — styles are inline and all state lives in React.

## Contributing

Issues and pull requests are welcome.

- Run `npm run lint` and `npm run build` before opening a pull request. CI runs both.
- Use British English, `£` and `en-GB` number and date formatting.
- Keep tax and threshold constants at the top of `src/App.jsx`, and link to the source (ideally gov.uk) when you change one.
- If you add a saved field, include it in `getAllState()` and load it defensively in `loadState()` so older save files keep working.
- **Never put real financial data in issues, pull requests, screenshots or example files.**

## Licence

Released under the [MIT Licence](LICENSE).

## Disclaimer

This software is for illustration and education only. It isn't financial, tax, mortgage or investment advice. Tax rules, rates and lender practices change, and your circumstances may not match the simplifications above. It comes with no warranty — see the [licence](LICENSE).
