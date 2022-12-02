require("dotenv").config();
const router = require("express").Router();
const pool = require("../db");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");
const dayjs = require("dayjs");
const { auth, OAuth2Client } = require("google-auth-library");
const authenticateToken = require("../utilities/authenticateToken");
const accNo = require("../utilities/acc");
const randomString = require("random-string");

// Google Oauth handler
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const REFRESH_TOKEN = process.env.CLIENT_REFRESH_TOKEN;
const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

//router
const { Router } = require("express");

//Adds the first 3 numbers needed in creating the account number
const accTypeSavings = "102";
const accTypeCurrent = "202";

// get User
router.get("/user", authenticateToken, async (req, res) => {
  try {
    const userId = req.user;
    const userAccounts = await pool.query(
      "SELECT * FROM accounts WHERE customer_id = $1 ORDER BY c_date ASC, c_time ASC",
      [userId]
    );

    res.json({ accounts: userAccounts.rows });
  } catch (error) {
    console.log(error.message);
  }
});

// get transactions
router.get("/transactions/:no", authenticateToken, async (req, res) => {
  try {
    const userId = req.user;
    const accountNo = req.params.no;
    const userAccount = await pool.query(
      "SELECT * FROM accounts WHERE account_no = $1",
      [accountNo]
    );
    const userTransactions = await pool.query(
      "SELECT * FROM transactions WHERE s_account_no = $1 AND transaction_type = $4  OR r_account_no = $2 AND transaction_status = $3 AND transaction_type = $5 ORDER BY transaction_date DESC, transaction_time DESC",
      [accountNo, accountNo, "Successful", "Debit", "Credit"]
    );

    res.json({ transactions: userTransactions.rows });
  } catch (error) {
    console.log(error.message);
  }
});

// Creates new account for users with 1 or more accounts
router.post("/newaccount", authenticateToken, async (req, res) => {
  try {
    const userId = req.user;
    const accountType = req.body.accType;

    // dummy account balance for testing
    const accBal = 5000;

    // Gets email from customer records
    const userEmail = await pool.query(
      "SELECT * FROM customers WHERE customer_id = $1",
      [userId]
    );

    // Generates first 3 digits of the account number based on accType selected from client side
    let typeAcc = await function () {
      let usn = "";
      if (accountType === "Savings") {
        return (usn = accTypeSavings);
      } else if (accountType === "Current") {
        return (usn = accTypeCurrent);
      }
    };

    // Hashes 4Digitpin
    const hashedPassword = await bcrypt.hash(req.body.password, 10);

    //Creates New account
    const newAcc = await pool.query(
      "INSERT INTO accounts(account_no,customer_id,account_bal,account_type,account_4digitpin,account_status,account_name,c_date,c_time) VALUEs ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [
        `${typeAcc()}${accNo.index()}`,
        userEmail.rows[0].customer_id,
        accBal,
        accountType,
        hashedPassword,
        "Opened",
        `${userEmail.rows[0].first_name} ${userEmail.rows[0].last_name}`,
        dayjs().format("YYYY-MM-DD"),
        dayjs().format("HH:mm:ss"),
      ]
    );

    const email = userEmail.rows[0].customer_email;
    const name = newAcc.rows[0].account_name;
    const numb = newAcc.rows[0].account_no;
    const type = newAcc.rows[0].account_type;

    //Deletes customer from Limbo
    const deleteVerificationCode = await pool.query(
      "DELETE FROM limbo WHERE customer_email = $1",
      [email]
    );

    // If creating the new account was unsuccessful
    if (!newAcc)
      return res.status(403).json({ error: "something went wrong!" });

    // After successfully creating the new account send the account details to the customers email
    if (newAcc) {
      //Get access token
      const accessToken = await oAuth2Client.getAccessToken();

      //credentials for email transportation
      const transport = nodemailer.createTransport({
        service: "gmail",
        auth: {
          type: "OAuth2",
          user: "edifyit1@gmail.com",
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          refreshToken: REFRESH_TOKEN,
          accessToken: accessToken,
        },
      });

      //Email verification message
      const msg = {
        from: "The Vault <edifyit1@gmail.com>", // sender address
        to: email, // list of receivers
        subject: "Account Details", // Subject line
        text: `${name} here are your account details, Account Name: ${name}, Account Number: ${numb}, Account Type: ${type}. Thanks for choosing THE VAULT...`, // plain text body
        html: `<h1>Account Details</h1>
            <p><strong>${name}</strong> here are your account details<br><br>
            Account Name: ${name}<br>
            Account Number: ${numb}<br>
            Account Type: ${type}<br><br>
            <strong>Thanks for choosing THE VAULT...</strong></p>`, //HTML message
      };

      // send mail with defined transport object
      const info = await transport.sendMail(msg);

      // sends the status code, message and account details to the client as response
      return res.status(200).json({
        Registration: "Successful!",
        account: {
          accName: newAcc.rows[0].account_name,
          accNo: newAcc.rows[0].account_no,
          accType: newAcc.rows[0].account_type,
        },
      });
    }
  } catch (error) {
    res.json({ err: error.message });
    console.log(error);
  }
});

// gets the receiver
router.post("/receiver", authenticateToken, async (req, res) => {
  try {
    const userId = req.user;
    const sender = req.body.senderNo;
    const accNo = req.body.receiverNo;

    // queries the database for the receiver ans sender's account
    const requestAcc = await pool.query(
      "SELECT * FROM accounts WHERE account_no = $1",
      [sender]
    );
    const receiverAcc = await pool.query(
      "SELECT * FROM accounts WHERE account_no = $1",
      [accNo]
    );

    // Checks for malicious requests
    if (
      receiverAcc.rows.length === 0 ||
      userId !== requestAcc.rows[0].customer_id
    )
      return res.status(403).json({ error: "Unauthenticated request" });

    // sends the receivers account name to the frontend
    return res.status(200).json({ receiver: receiverAcc.rows[0].account_name });
  } catch (error) {
    console.log(error.message);
  }
});

// Handles transfer requests
router.put("/transfers", authenticateToken, async (req, res) => {
  try {
    const userId = req.user;
    const amount = req.body.cash;
    const sender = req.body.sender;
    const pin = req.body.password;
    const receiverNo = req.body.benefactor;

    // Checks for pin content
    if (pin.length === 0) return res.status(411).json({ error: "Empty pin!" });

    // queries the database for the receiver ans sender's account
    const requestAcc = await pool.query(
      "SELECT * FROM accounts WHERE account_no = $1",
      [sender]
    );

    const receiverAcc = await pool.query(
      "SELECT * FROM accounts WHERE account_no = $1",
      [receiverNo]
    );

    // Checks for malicious requests
    if (
      receiverAcc.rows.length === 0 ||
      userId !== requestAcc.rows[0].customer_id
    )
      return res.status(401).json({ error: "Unauthenticated request" });

    // Hashes password
    const hashedPassword = await bcrypt.compare(
      pin,
      requestAcc.rows[0].account_4digitpin
    );

    // Checks pin
    if (!hashedPassword)
      return res.status(400).json({ error: "Incorrect Pin!" });

    // Checks for blocked accounts
    if (requestAcc.rows[0].account_status === "Closed")
      return res.status(403).json({ error: "Account Blocked!" });

    const charge = (Number(amount) * 0.5) / 100;
    const totalCharge = Number(amount) + Number(charge);

    // Checks for sufficient funds
    if (Number(requestAcc.rows[0].account_bal) < Number(totalCharge)) {
      // creates a receipt for failed transaction
      const failed = await pool.query(
        "INSERT INTO transactions(s_account,r_account,s_account_no,r_account_no,transaction_type,transaction_date,transaction_time,transaction_amount,transaction_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [
          requestAcc.rows[0].account_name,
          receiverAcc.rows[0].account_name,
          sender,
          receiverNo,
          "Debit",
          dayjs().format("YYYY-MM-DD"),
          dayjs().format("HH:mm:ss"),
          Number(totalCharge),
          "Failed",
        ]
      );

      // adds the parent id for the failed transaction
      await pool.query(
        "UPDATE transactions SET parent_transaction_id = $1 WHERE transaction_id = $2",
        [failed.rows[0].transaction_id, failed.rows[0].transaction_id]
      );

      // response to the frontend
      return res.status(405).json({ error: "Insufficient funds" });
    }

    // Gets the current balance for both users
    const sent = Number(requestAcc.rows[0].account_bal) - Number(totalCharge);
    const received = Number(receiverAcc.rows[0].account_bal) + Number(amount);

    // the official account for the vault
    const theVaultAcc = "1027557580";

    // gets account details for the vault
    const bank = await pool.query(
      "SELECT * FROM accounts WHERE account_no = $1",
      [theVaultAcc]
    );

    // checks if the customer making the request has enough cash for the transaction
    if (requestAcc.rows[0].account_bal >= Number(amount)) {
      // updates the vault account with the charge
      await pool.query(
        "UPDATE accounts SET account_bal = $1 WHERE account_no = $2",
        [Number(bank.rows[0].account_bal) + Number(charge), theVaultAcc]
      );
      // updates the senders account balance
      await pool.query(
        "UPDATE accounts SET account_bal = $1 WHERE account_no = $2",
        [sent, requestAcc.rows[0].account_no]
      );
      // updates the receivers account balance
      await pool.query(
        "UPDATE accounts SET account_bal = $1 WHERE account_no = $2",
        [received, receiverAcc.rows[0].account_no]
      );

      // creates transaction receipts for sender and receiver
      const parent = await pool.query(
        "INSERT INTO transactions(s_account,r_account,s_account_no,r_account_no,transaction_type,transaction_date,transaction_time,transaction_amount,transaction_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [
          requestAcc.rows[0].account_name,
          receiverAcc.rows[0].account_name,
          sender,
          receiverNo,
          "Debit",
          dayjs().format("YYYY-MM-DD"),
          dayjs().format("HH:mm:ss"),
          Number(totalCharge),
          "Successful",
        ]
      );
      const child = await pool.query(
        "INSERT INTO transactions(s_account,r_account,s_account_no,r_account_no,transaction_type,transaction_date,transaction_time,transaction_amount,transaction_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [
          requestAcc.rows[0].account_name,
          receiverAcc.rows[0].account_name,
          sender,
          receiverNo,
          "Credit",
          dayjs().format("YYYY-MM-DD"),
          dayjs().format("HH:mm:ss"),
          Number(amount),
          "Successful",
        ]
      );

      // updates transaction receipts ID for sender and receiver
      await pool.query(
        "UPDATE transactions SET parent_transaction_id = $1, child_transaction_id = $2 WHERE transaction_id = $3",
        [
          parent.rows[0].transaction_id,
          child.rows[0].transaction_id,
          parent.rows[0].transaction_id,
        ]
      );

      await pool.query(
        "UPDATE transactions SET parent_transaction_id = $1, child_transaction_id = $2 WHERE transaction_id = $3",
        [
          parent.rows[0].transaction_id,
          child.rows[0].transaction_id,
          child.rows[0].transaction_id,
        ]
      );

      // response
      return res
        .status(200)
        .json({ receiver: receiverAcc.rows[0].account_name });
    }
  } catch (error) {
    console.log(error.message);
  }
});

/* Pin reset section */

// sends confirmation code to customer's email
router.post("/codecheck1", authenticateToken, async (req, res) => {
  try {
    const userId = req.user;
    const no = req.body.no;

    const customer = await pool.query(
      "SELECT * FROM customers WHERE customer_id = $1",
      [userId]
    );

    const account = await pool.query(
      "SELECT * FROM accounts WHERE account_no = $1",
      [no]
    );

    if (account.rows.length === 0)
      return res.status(401).json({ error: "Account is non-existent!" });

    if (account.rows[0].customer_id !== userId)
      return res.status(403).json({ error: "You don not own this account!" });

    const email = customer.rows[0].customer_email;

    const deleteVerificationCode = await pool.query(
      "DELETE FROM limbo WHERE customer_email = $1",
      [email]
    );

    // Creates confirmation code
    const verify = randomString({ length: 5 });

    //Get access token
    const accessToken = await oAuth2Client.getAccessToken();

    //credentials for email transportation
    const transport = nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2",
        user: "edifyit1@gmail.com",
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: REFRESH_TOKEN,
        accessToken: accessToken,
      },
    });

    //Email verification message
    const msg = {
      from: "The Vault <edifyit1@gmail.com>", // sender address
      to: email, // list of receivers
      subject: "Pin Reset", // Subject line
      text: `Your pin reset code is ${verify}. If you did not try to reset your pin, kindly ignore this email.Someone typed in your account by mistake.`, // plain text body
      html: `<h1>Pin Reset</h1>
            <p>${customer.rows[0].first_name} your pin reset code is <strong>${verify}</strong><br>for ${no}<br>
            If you did not try to reset your pin, kindly ignore this email. Someone typed in your account by mistake.</p>`, //HTML message
    };

    // send mail with defined transport object
    const info = await transport.sendMail(msg);

    //saves new customer in limbo
    const customerInLimbo = await pool.query(
      "INSERT INTO limbo(customer_email,account_verifyy) VALUES ($1,$2) RETURNING *",
      [email, verify]
    );

    return res.status(200).json("good");
  } catch (error) {
    return res.status(411).json({ error: error.message });
  }
});

// checks confirmation code
router.post("/codechecka1", authenticateToken, async (req, res) => {
  try {
    const userId = req.user;
    const no = req.body.no;
    const code = req.body.code;

    const customer = await pool.query(
      "SELECT * FROM customers WHERE customer_id = $1",
      [userId]
    );

    const account = await pool.query(
      "SELECT * FROM accounts WHERE account_no = $1",
      [no]
    );

    if (account.rows.length === 0)
      return res.status(401).json({ error: "Account is non-existent!" });

    if (account.rows[0].customer_id !== userId)
      return res.status(403).json({ error: "You don not own this account!" });

    const email = customer.rows[0].customer_email;

    const customerInLimbo = await pool.query(
      "SELECT * FROM limbo WHERE customer_email = $1",
      [email]
    );

    // checks for valid verification code
    if (customerInLimbo.rows === 0)
      return res.status(400).json({ error: "Verification code non-existent!" });

    if (customerInLimbo.rows[0].account_verifyy !== code)
      return res
        .status(402)
        .json({ error: "expired or invalid verification code!" });

    // deletes verification code after complete verification
    const deleteVerificationCode = await pool.query(
      "DELETE FROM limbo WHERE customer_email = $1",
      [email]
    );

    // response
    return res.status(200).json("good");
  } catch (error) {
    return res.status(401).json({ error: error.message });
  }
});

// pin rester API
router.put("/resetpass1", authenticateToken, async (req, res) => {
  try {
    const userId = req.user;
    const { no, password } = req.body;

    const customer = await pool.query(
      "SELECT * FROM customers WHERE customer_id = $1",
      [userId]
    );

    const account = await pool.query(
      "SELECT * FROM accounts WHERE account_no = $1",
      [no]
    );

    if (account.rows.length === 0)
      return res.status(401).json({ error: "Account is non-existent!" });

    // incase someone tries using tools like postman to make the API call
    if (account.rows[0].customer_id !== userId)
      return res.status(403).json({ error: "You don not own this account!" });

    const email = customer.rows[0].customer_email;

    // hashes pin
    const hashedPassword = await bcrypt.hash(password, 10);

    // updates pin
    const pWordUpdate = await pool.query(
      "UPDATE accounts SET account_4digitpin = $1 WHERE customer_id = $2",
      [hashedPassword, userId]
    );

    // deletes verification code incase it wasn't successfully deleted in previous API
    const deleteVerificationCode = await pool.query(
      "DELETE FROM limbo WHERE customer_email = $1",
      [email]
    );

    // response
    return res.status(200).json("Password updated!");
  } catch (error) {
    return res.status(401).json({ error: error.message });
  }
});
/* pin reset section ends */

//Exports users-routes.js
module.exports = router;
