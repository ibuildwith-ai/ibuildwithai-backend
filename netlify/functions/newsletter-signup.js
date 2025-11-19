const { Resend } = require('resend');
const mailchimp = require('@mailchimp/mailchimp_marketing');

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS_PER_WINDOW = 3; // Reduced from 5 for better security
const ipRequestMap = new Map();

// Cleanup old rate limit entries every hour
setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of ipRequestMap.entries()) {
        if (now - data.startTime > RATE_LIMIT_WINDOW) {
            ipRequestMap.delete(ip);
        }
    }
}, RATE_LIMIT_WINDOW);

exports.handler = async (event, context) => {
    // Enable CORS - Restricted to domain only
    const headers = {
        'Access-Control-Allow-Origin': 'https://ibuildwith.ai',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    // Handle preflight OPTIONS request
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    // Rate Limiting
    const clientIp = event.headers['client-ip'] || event.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();

    if (clientIp !== 'unknown') {
        const requestData = ipRequestMap.get(clientIp) || { count: 0, startTime: now };

        if (now - requestData.startTime > RATE_LIMIT_WINDOW) {
            // Reset window
            requestData.count = 1;
            requestData.startTime = now;
        } else {
            requestData.count++;
        }

        ipRequestMap.set(clientIp, requestData);

        if (requestData.count > MAX_REQUESTS_PER_WINDOW) {
            return {
                statusCode: 429,
                headers,
                body: JSON.stringify({ error: 'Too many requests. Please try again later.' })
            };
        }
    }

    try {
        const data = JSON.parse(event.body);
        const { firstName, lastName, email } = data;

        // Basic Validation
        if (!firstName || !lastName || !email) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Missing required fields' })
            };
        }

        // Email Validation - requires valid TLD (min 2 characters)
        const emailRegex = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
        if (!emailRegex.test(email)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Invalid email format' })
            };
        }

        // 1. Send Notification Email via Resend
        const resend = new Resend(process.env.RESEND_API_KEY);

        const emailContent = `
      New Newsletter Signup:
      
      First Name: ${firstName}
      Last Name: ${lastName}
      Email: ${email}
      
      Date: ${new Date().toLocaleString()}
    `;

        await resend.emails.send({
            from: 'contact@send.ibuildwith.ai', // Ensure this domain is verified in Resend
            to: process.env.RECIPIENT_EMAIL,
            subject: `New Newsletter Signup from ${firstName} ${lastName}`,
            text: emailContent,
        });

        // 2. Add to Mailchimp
        if (process.env.MAILCHIMP_API_KEY && process.env.MAILCHIMP_SERVER_PREFIX && process.env.MAILCHIMP_LIST_ID) {
            mailchimp.setConfig({
                apiKey: process.env.MAILCHIMP_API_KEY,
                server: process.env.MAILCHIMP_SERVER_PREFIX,
            });

            try {
                await mailchimp.lists.addListMember(process.env.MAILCHIMP_LIST_ID, {
                    email_address: email,
                    status: 'subscribed',
                    merge_fields: {
                        FNAME: firstName,
                        LNAME: lastName
                    }
                });
            } catch (mcError) {
                // Handle "Member Exists" error (400)
                if (mcError.status === 400 && mcError.response && mcError.response.body.title === 'Member Exists') {
                    console.log(`Email ${email} is already subscribed to Mailchimp.`);
                    // We consider this a success from the user's perspective
                } else {
                    console.error('Mailchimp Error:', mcError);
                    // We log the error but don't fail the request if the email notification succeeded
                    // Or we could return a warning. For now, let's proceed as success but log it.
                }
            }
        } else {
            console.warn('Mailchimp environment variables not set. Skipping Mailchimp integration.');
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, message: 'Successfully subscribed' })
        };

    } catch (error) {
        console.error('Error processing newsletter signup:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal Server Error' })
        };
    }
};
