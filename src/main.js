const core = require('@actions/core')
const { exec } = require('@actions/exec')
const { wait } = require('./wait')
const { boltService } = require('./bolt_service')
const { releaseVersion } = require('./version')
const YAML = require('yaml')
const fs = require('fs')
const {
  getMode,
  getAllowHTTP,
  getDefaultPolicy,
  getEgressRules,
  getTrustedGithubAccounts 
} = require('./input')

const mode = getMode()
const allowHTTP = getAllowHTTP()
const defaultPolicy = getDefaultPolicy()
const egressRules = getEgressRules()
const trustedGithubAccounts = getTrustedGithubAccounts()

let startTime = Date.now()

function benchmark(featureName) {
  const endTime = Date.now()
  core.info(
    `Time Elapsed in ${featureName}: ${Math.ceil((endTime - startTime) / 1000)}s`
  )
  startTime = endTime
}

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
async function run() {
  try {
    startTime = Date.now()
    core.info(`Start time: ${startTime}`)

    // Changing boltUser will require changes in bolt.service and intercept.py
    const boltUser = 'bolt'
    core.saveState('boltUser', boltUser)

    const outputFile = 'output.log'
    core.saveState('outputFile', outputFile)

    const homeDir = `/home/${boltUser}`
    core.saveState('homeDir', homeDir)

    const repoName = process.env.GITHUB_REPOSITORY; // e.g. koalalab-inc/bolt
    const repoOwner = repoName.split('/')[0]; // e.g. koalalab-inc


    core.startGroup('create-bolt-user')
    core.info('Creating bolt user...')
    await exec(`sudo useradd ${boltUser}`)
    await exec(`sudo mkdir -p /home/${boltUser}`)
    await exec(`sudo chown ${boltUser}:${boltUser} /home/${boltUser}`)
    core.info('Creating bolt user... done')
    core.endGroup('create-bolt-user')

    benchmark('create-bolt-user')

    core.startGroup('download-executable')
    const releaseName = 'bolt'
    // const extractDir = 'home/runner/bolt'
    // await exec(`mkdir -p ${extractDir}`)
    core.info('Downloading mitmproxy...')
    // const releaseVersion = 'v1.3.0-rc'
    const filename = `${releaseName}-${releaseVersion}-linux-x86_64.tar.gz`
    // Sample URL :: https://api-do-blr.koalalab.com/bolt/package/v0.7.0/bolt-v0.7.0-linux-x86_64.tar.gz
    // Sample Backup URL :: https://github.com/koalalab-inc/bolt/releases/download/v0.7.0/bolt-v0.7.0-linux-x86_64.tar.gz
    let referrer = ''
    try {
      const workflowName = process.env.GITHUB_WORKFLOW.replace(/\//g, "|"); // e.g. CI
      const jobName = process.env.GITHUB_JOB; // e.g. build
      referrer = `github.com/${repoName}/${workflowName}/${jobName}`
    } catch (error) {
      core.info('Error getting referrer')
    }
    const primaryDownloadExitCode = await exec(
      `wget --quiet --header "Referrer: ${referrer}" https://api-do-blr.koalalab.com/bolt/package/${releaseVersion}/${filename}`
    )
    if (primaryDownloadExitCode !== 0) {
      core.info('Primary download failed, trying backup...')
      await exec(
        `wget --quiet https://github.com/koalalab-inc/bolt/releases/download/${releaseVersion}/${filename}`
      )
    }
    core.info('Downloading mitmproxy... done')
    await exec(`tar -xzf ${filename}`)
    await exec(`sudo cp bolt/mitmdump /home/${boltUser}/`)
    await exec(`sudo chown ${boltUser}:${boltUser} /home/${boltUser}/mitmdump`)
    await exec(`sudo cp bolt/intercept.py /home/${boltUser}/`)
    await exec(`sudo chown ${boltUser}:${boltUser} /home/${boltUser}/intercept.py`)
    core.endGroup('download-executable')

    benchmark('download-executable')

    core.startGroup('setup-bolt')
    core.info('Reading inputs...')
    const trustedGithubAccountsString = [repoOwner, ...trustedGithubAccounts].join(',')
    const egressRulesYAML = YAML.stringify(egressRules)
    core.info('Reading inputs... done')

    core.info('Create bolt output file...')
    await exec(
      `sudo -u ${boltUser} -H bash -c "touch /home/${boltUser}/output.log`
    )
    core.info('Create bolt output file... done')

    core.info('Create bolt config...')
    const boltConfig = `dump_destination: "/home/${boltUser}/output.log"`
    fs.writeFileSync('config.yaml', boltConfig)
    await exec(
      `sudo -u ${boltUser} -H bash -c "mkdir -p /home/${boltUser}/.mitmproxy"`
    )
    await exec(`sudo cp config.yaml /home/${boltUser}/.mitmproxy/`)
    await exec(
      `sudo chown ${boltUser}:${boltUser} /home/${boltUser}/.mitmproxy/config.yaml`
    )
    core.info('Create bolt config... done')

    core.info('Create bolt egress_rules.yaml...')
    fs.writeFileSync('egress_rules.yaml', egressRulesYAML)
    await exec(`sudo cp egress_rules.yaml /home/${boltUser}/`)
    await exec(
      `sudo chown ${boltUser}:${boltUser} /home/${boltUser}/egress_rules.yaml`
    )
    core.info('Create bolt egress_rules.yaml... done')

    core.info('Create bolt service log files...')
    const logFile = `/home/${boltUser}/bolt.log`
    const errorLogFile = `/home/${boltUser}/bolt-error.log`
    await exec(`sudo touch ${logFile}`)
    await exec(`sudo touch ${errorLogFile}`)
    await exec(`sudo chown ${boltUser}:${boltUser} ${logFile} ${errorLogFile}`)
    core.info('Create bolt service log files... done')

    core.info('Create bolt service...')
    const boltServiceConfig = await boltService(
      boltUser,
      mode,
      allowHTTP,
      defaultPolicy,
      trustedGithubAccountsString,
      logFile,
      errorLogFile
    )
    fs.writeFileSync('bolt.service', boltServiceConfig)
    await exec('sudo cp bolt.service /etc/systemd/system/')
    await exec('sudo chown root:root /etc/systemd/system/bolt.service')
    await exec('sudo systemctl daemon-reload')
    core.info('Create bolt service... done')
    core.endGroup('setup-bolt')

    benchmark('configure-bolt')

    core.startGroup('run-bolt')
    core.info('Starting bolt...')
    await exec('sudo systemctl start bolt')
    core.info('Waiting for bolt to start...')
    await exec('sudo systemctl status bolt')
    core.info('Starting bolt... done')
    core.endGroup('run-bolt')

    benchmark('start-bolt')

    core.startGroup('trust-bolt-certificate')
    core.info('Trust bolt certificate...')
    const ms = 500
    for (let i = 1; i <= 10; i++) {
      try {
        await wait(ms)
        await exec(
          `sudo cp /home/${boltUser}/.mitmproxy/mitmproxy-ca-cert.pem /usr/local/share/ca-certificates/bolt.crt`
        )
        const boltCertDir = '/home/runner/.bolt/certs'
        const boltCertPath = `${boltCertDir}/bolt.crt`
        await exec(`mkdir -p ${boltCertDir}`)
        await exec(
          `sudo cp /home/${boltUser}/.mitmproxy/mitmproxy-ca-cert.pem ${boltCertPath}`
        )
        await exec(
          `sudo chown runner:runner ${boltCertPath}`
        )
        core.exportVariable('NODE_EXTRA_CA_CERTS', boltCertPath)
        await exec('sudo update-ca-certificates')
        break
      }
      catch (error) {
        core.info(`waiting for bolt to start, retrying in ${ms}ms...`)
      }
    }
    core.info('Trust bolt certificate... done')
    core.endGroup('trust-bolt-certificate')
    
    benchmark('trust-bolt-certificate')

    core.startGroup('setup-iptables-redirection')
    await exec('sudo sysctl -w net.ipv4.ip_forward=1')
    await exec('sudo sysctl -w net.ipv6.conf.all.forwarding=1')
    await exec('sudo sysctl -w net.ipv4.conf.all.send_redirects=0')
    await exec(
      `sudo iptables -t nat -A OUTPUT -p tcp -m owner ! --uid-owner ${boltUser} --dport 80 -j REDIRECT --to-port 8080`
    )
    await exec(
      `sudo iptables -t nat -A OUTPUT -p tcp -m owner ! --uid-owner ${boltUser} --dport 443 -j REDIRECT --to-port 8080`
    )
    await exec(
      `sudo ip6tables -t nat -A OUTPUT -p tcp -m owner ! --uid-owner ${boltUser} --dport 80 -j REDIRECT --to-port 8080`
    )
    await exec(
      `sudo ip6tables -t nat -A OUTPUT -p tcp -m owner ! --uid-owner ${boltUser} --dport 443 -j REDIRECT --to-port 8080`
    )
    core.endGroup('setup-iptables-redirection')

    benchmark('setup-iptables-redirection')
  } catch (error) {
    // Fail the workflow run if an error occurs
    core.saveState('boltFailed', 'true')
    core.setFailed(error.message)
  }
}

module.exports = {
  run
}
