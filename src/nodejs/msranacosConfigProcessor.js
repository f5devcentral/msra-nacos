/*
  Copyright (c) 2017, F5 Networks, Inc.
  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at
  *
  http://www.apache.org/licenses/LICENSE-2.0
  *
  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
  either express or implied. See the License for the specific
  language governing permissions and limitations under the License.
  
  Updated by Ping Xiong on May/04/2022.
*/

'use strict';

// Middleware. May not be installed.
var configTaskUtil = require("./configTaskUtil");
var blockUtil = require("./blockUtils");
var logger = require('f5-logger').getInstance();
var mytmsh = require('./TmshUtil');
const fetch = require('node-fetch');
const Bluebird = require('bluebird');
fetch.Promise = Bluebird;
//var EventEmitter = require('events').EventEmitter;
//var stopPollingEvent = new EventEmitter(); 


// Setup a polling signal for audit.
var fs = require('fs');
const msranacosOnPollingSignal = '/var/tmp/msranacosOnPolling';



//const pollInterval = 10000; // Interval for polling Registry registry.
var stopPolling = false;

const nacosAPI = "/nacos/v1/ns/instance/list?serviceName=";
// For functionnal verification
//const poolName = 'pool_msra_demo';
//const poolType = 'round-robin';
//const healthMonitor = 'tcp';
var poolMembers = '{100.100.100.100:8080 100.100.100.101:8080}';
//const commandCreatePool ='tmsh -a create ltm pool pool_msra_demo monitor tcp load-balancing-mode round-robin members replace-all-with { 100.100.100.100:8080 100.100.100.101:8080 }';
//const commandUpdatePool ='tmsh -a modify ltm pool pool_msra_demo monitor tcp load-balancing-mode round-robin members replace-all-with { 100.100.100.100:8080 100.100.100.101:8080 }';
//const commandDeletePool ='tmsh -a delete ltm pool pool_msra_demo';

// tmsh -a create ltm pool /Common/pool_msra_demo
// tmsh -a modify ltm pool /Common/pool_msra_demo monitor tcp load-balancing-mode round-robin members replace-all-with { 100.100.100.100:8080 100.100.100.101:8080 }

/**
 * A dynamic config processor for managing LTM pools.
 * Note that the pool member name is not visible in the GUI. It is generated by MCP according to a pattern, we don't want
 * the user setting it
 *
 * @constructor
 */
function msranacosConfigProcessor() {
}

msranacosConfigProcessor.prototype.setModuleDependencies = function (options) {
    logger.info("setModuleDependencies called");
    configTaskUtil = options.configTaskUtil;
};

msranacosConfigProcessor.prototype.WORKER_URI_PATH = "shared/iapp/processors/msranacosConfig";

msranacosConfigProcessor.prototype.onStart = function (success) {
    logger.fine("msra: OnStart, msranacosConfigProcessor.prototype.onStart");
    this.apiStatus = this.API_STATUS.INTERNAL_ONLY;
    this.isPublic = true;

    configTaskUtil.initialize({
        restOperationFactory: this.restOperationFactory,
        eventChannel: this.eventChannel,
        restHelper: this.restHelper
    });

    // Clear the polling signal for audit.
    try {
        fs.access(msranacosOnPollingSignal, fs.constants.F_OK, function (err) {
            if (err) {
                logger.fine("msranacos audit OnStart, the polling signal is off. ", err.message);
            } else {
                logger.fine("msra nacos audit onStart: ConfigProcessor started, clear the signal.");
                fs.unlinkSync(msranacosOnPollingSignal);
            }
        });
    } catch(err) {
        logger.fine("msranacos: OnStart, hits error while check pooling signal. ", err.message);
    }

    success();
};


/**
 * Handles initial configuration or changed configuration. Sets the block to 'BOUND' on success
 * or 'ERROR' on failure. The routine is resilient in that it will try its best and always go
 * for the 'replace' all attitude.
 *
 * @param restOperation - originating rest operation that triggered this processor
 */
msranacosConfigProcessor.prototype.onPost = function (restOperation) {
    var configTaskState,
        blockState,
        oThis = this;
    logger.fine("msra: onPost, msranacosConfigProcessor.prototype.onPost");

    var inputProperties;
    var dataProperties;
    try {
        configTaskState = configTaskUtil.getAndValidateConfigTaskState(restOperation);
        blockState = configTaskState.block;
        logger.fine("msra: onPost, inputProperties ", blockState.inputProperties);
        logger.fine("msra: onPost, dataProperties ", blockState.dataProperties);
        inputProperties = blockUtil.getMapFromPropertiesAndValidate(
          blockState.inputProperties,
          [
            "nacosEndpoint",
            "nacosUserName",
            "nacosPassword",
            "namespaceId",
            "groupName",
            "clusterName",
            "serviceName",
            "ipAddr",
            "port"
          ]
        );
        dataProperties = blockUtil.getMapFromPropertiesAndValidate(
            blockState.dataProperties,
            ["pollInterval"]
        );

    } catch (ex) {
        restOperation.fail(ex);
        return;
    }

    // Mark that the request meets all validity checks and tell the originator it was accepted.
    this.completeRequest(restOperation, this.wellKnownPorts.STATUS_ACCEPTED);

    // Generic URI components, minus the 'path'
    var uri = this.restHelper.buildUri({
        protocol: this.wellKnownPorts.DEFAULT_HTTP_SCHEME,
        port: this.wellKnownPorts.DEFAULT_JAVA_SERVER_PORT,
        hostname : "localhost"
    });

    //Accept input proterties, set the status to BOUND.

    const inputEndPoint = inputProperties.nacosEndpoint.value;
    const inputUserName = inputProperties.nacosUserName.value;
    const inputPassword = inputProperties.nacosPassword.value;
    const inputNamespaceId = inputProperties.namespaceId.value;
    const inputGroupName = inputProperties.groupName.value;
    const inputClusterName = inputProperties.clusterName.value;
    const inputServiceName = inputProperties.serviceName.value;
    const inputIpAddr = inputProperties.ipAddr.value;
    const inputPort = inputProperties.port.value;
    var pollInterval = dataProperties.pollInterval.value * 1000;
    //var accessToken = "";

    const instanceDest = inputIpAddr + ':' + inputPort;
    const nacosAuthUrl = inputEndPoint + '/nacos/v1/auth/login';
    const nacosCrendential = 'username=' + inputUserName + '&password=' + inputPassword;
    var instanceUrl = inputEndPoint +   "/nacos/v1/ns/instance?" +
        "namespaceId=" + inputNamespaceId +
        "&groupName=" + inputGroupName +
        "&inputClusterName=" + inputClusterName +
        "&serviceName=" + inputServiceName +
        "&ip=" + inputIpAddr +
        "&port=" + inputPort +
        "&ephemeral=false";
    var listInstanceUrl = inputEndPoint + '/nacos/v1/ns/instance/list?' +
        'serviceName=' + inputServiceName;


    //Handle an instance, for action parameter, 'POST' for register and 'DELETE' for unregister
    function handleInstance (action, instance) {
        // deregister an instance from nacos
        fetch(instance, { method: action})
            .then(function (res) {
                if (res.ok) { // res.status >= 200 && res.status < 300
                    logger.fine("MSRA: onPost, handle the instance: "+ instanceDest, res.statusText);
                } else {
                    logger.fine("MSRA: onPost, Failed to handle the instance: "+ instanceDest, res.statusText);
                }
            })
            .catch(err => logger.fine(err));
    }


    // Set the polling interval
    if (pollInterval) {
        if (pollInterval < 10000) {
            logger.fine("msra: onPost, pollInternal is too short, will set it to 10s ", pollInterval);
            pollInterval = 10000;
        }
    } else {
        logger.fine("msra: onPost, pollInternal is not set, will set it to 30s ", pollInterval);
        pollInterval = 30000;
    }

    // Setup the polling signal for audit
    try {
        logger.fine("msranacos: onPost, will set the polling signal. ");
        fs.writeFile(msranacosOnPollingSignal, '');
    } catch (error) {
        logger.fine("msranacos: onPost, hit error while set polling signal: ", error.message);
    }

    logger.fine("msra: onPost, Input properties accepted, change to BOUND status, start to poll Registry.");

    stopPolling = false;

    configTaskUtil.sendPatchToBoundState(configTaskState, 
            oThis.getUri().href, restOperation.getBasicAuthorization());

    // A internal service to retrieve service member information from registry, and then update BIG-IP setting.

    //inputEndPoint = inputEndPoint.toString().split(","); 
    logger.fine("msra: onPost, registry endpoints: " + inputEndPoint);

    // connect to nacos registry to retrieve end points.

    //const nacosAuthUrl = inputEndPoint + '/nacos/v1/auth/login';
    //const nacosCrendential = 'username=' + inputUserName + '&password=' + inputPassword;
    //var absoluteUrl = inputEndPoint + nacosAPI + inputServiceName;

    (function schedule() {
        var pollRegistry = setTimeout(function () {
            fetch(listInstanceUrl)
                .then(function (res) {
                    if (res.ok) { // res.status >= 200 && res.status < 300,  // json response
                        logger.fine('msra: onPost, access service hits return code: ', res.statusText);
                        return res.json();
                    } else {
                        logger.fine('msra: onPost, access service hits return code: ', res.statusText);
                        // what if 403 ? what else ?
                        if (res.statusText == 'Forbidden') {
                            logger.fine('msra: onPost, Hit 403, will retry: ');
                            fetch(nacosAuthUrl, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                    body: nacosCrendential
                                })
                                .then(function (res) {
                                    if (res.ok) { // res.status >= 200 && res.status < 300,  // json response
                                        return res.json();
                                    } else {
                                        logger.fine('msra: onPost, Sent auth with return code: ', res.statusText);
                                        // what if 403 ? what else ?
                                        return;
                                    }
                                })
                                .then(function (jsondata) {
                                    logger.fine('msra: onPost, accesToken: ', jsondata.accessToken);
                                    // Authenticated user, go ahead for further process.
                                    instanceUrl = instanceUrl + "&accessToken=" + jsondata.accessToken;
                                    listInstanceUrl = listInstanceUrl + "&accessToken=" + jsondata.accessToken;
                                })
                                .catch(function (error) {
                                    logger.fine("msra: onPost, Can't get accessToken: ", error.message);
                                });
                        }
                    }
                })
                .then(function(jsondata) {
                    let nodeAddress = [];
                    jsondata.hosts.forEach(element => {
                        nodeAddress.push(element.ip+ ":"+element.port);
                    });
                    logger.fine("msra: onPost, service endpoint list: ", nodeAddress);
                    if (nodeAddress.includes(instanceDest)) {
                        logger.fine("The VS in the list, will check the status of the VS in F5: ", instanceDest);
                        // will check the status of the virtual in F5, decide the action based on the healthcheck result.
                        // do tmsh to get the status of vs, if vs is available, do nothing, otherwise unregister the instance
                        mytmsh.executeCommand("tmsh -a show ltm virtual " + inputServiceName +' field-fmt').then(function (res) {
                            logger.fine("MSRA: onPost, Found the virtual server in F5, will check the availability: " + inputServiceName);
                            if (res.indexOf('status.availability-state available') >= 0) {
                                logger.fine("MSRA: onPost, the virtual server in F5 is available, will do nothing: " + inputServiceName);
                            } else {
                                logger.fine("MSRA: onPost, he virtual server is not available, will unregister from nacos server: " + inputServiceName);
                                // unregister an instance from nacos
                                handleInstance("DELETE", instanceUrl);
                            }
                        })
                        // Error handling
                        .catch(function (error) {
                            if (error.message.indexOf('was not found') >= 0) {
                                logger.fine("MSRA: onPost, virtual server not found, will unregister from nacos server: " + inputServiceName);

                                // deregister an instance from nacos
                                handleInstance("DELETE", instanceUrl);
                                return;
                            }
                            logger.fine("MSRA: onPost, Fail to check status of the virtual server: " + error.message);
                            return;
                        });
                    } else {
                        logger.fine("The VS is not in the list, will check the status of VS.", instanceDest);
                        // do tmsh to get the status of vs, if vs is available, register the instance, otherwise do nothing.
                        mytmsh.executeCommand("tmsh -a show ltm virtual " + inputServiceName +' field-fmt').then(function (res) {
                            logger.fine("MSRA: onPost, Found the virtual server in F5, will check the availability: " + inputServiceName);
                            if (res.indexOf('status.availability-state available') >= 0) {
                                logger.fine("MSRA: onPost, the virtual server in F5 is available, will register it to nacos server: " + inputServiceName);
                                // register an instance to nacos
                                handleInstance('POST', instanceUrl);
                            } else {
                                logger.fine("MSRA: onPost, the virtual server in F5 is NOT available, will not to register it into nacos: " + inputServiceName);
                            }
                        })
                        // Error handling
                        .catch(function (error) {
                            if (error.message.indexOf('was not found') >= 0) {
                                logger.fine("MSRA: onPost, virtual server not found: " + inputServiceName);
                                return;
                            }
                            logger.fine("MSRA: onPost, Fail to check status of the virtual server: " + error.message);
                            return;
                        });
                    }
                }, function (err) {
                    logger.fine("msra: onPost, Fail to retrieve service endpoint list due to: ", err.message);
                }).catch(function (error) {
                    logger.fine("msra: onPost, Fail to retrieve service endpoint list due to: ", error.message);
                });
            schedule();
        }, pollInterval);

        // stop polling while undeployment
        if (stopPolling) {
            process.nextTick(() => {
                clearTimeout(pollRegistry);
                logger.fine("msra: onPost/stopping, Stop polling registry ...");
            });
            // Delete pool configuration in case it still there.
            setTimeout(function () {
                // deregister an instance from nacos
                logger.fine("msra: onPost/stopping, unregister the service from nacos ...");
                handleInstance("DELETE", instanceUrl);
            }, 2000);
        }

    })();
};


/**
 * Handles DELETE. The configuration must be removed, if it exists. Patch the block to 'UNBOUND' or 'ERROR'
 *
 * @param restOperation - originating rest operation that triggered this processor
 */
msranacosConfigProcessor.prototype.onDelete = function (restOperation) {
    var configTaskState,
        blockState;
    var oThis = this;

    logger.fine("msra: onDelete, msranacosConfigProcessor.prototype.onDelete");

    var inputProperties;
    try {
        configTaskState = configTaskUtil.getAndValidateConfigTaskState(restOperation);
        blockState = configTaskState.block;
        inputProperties = blockUtil.getMapFromPropertiesAndValidate(blockState.inputProperties,
            ["serviceName"]);
    } catch (ex) {
        restOperation.fail(ex);
        return;
    }
    this.completeRequest(restOperation, this.wellKnownPorts.STATUS_ACCEPTED);

    // Generic URI components, minus the 'path'
    var uri = this.restHelper.buildUri({
        protocol: this.wellKnownPorts.DEFAULT_HTTP_SCHEME,
        port: this.wellKnownPorts.DEFAULT_JAVA_SERVER_PORT,
        hostname: "localhost"
    });

    // change the state to UNBOUND
    
    configTaskUtil.sendPatchToUnBoundState(configTaskState, 
                oThis.getUri().href, restOperation.getBasicAuthorization());
    
    // Stop polling registry while undeploy ??
    process.nextTick(() => {
        stopPolling = true;
        logger.fine("msra: onDelete/stopping, Stop polling registry ...");
    });
    //stopPollingEvent.emit('stopPollingRegistry');
    logger.fine("msra: onDelete, Stop polling Registry while ondelete action, unregister the service.");
};

module.exports = msranacosConfigProcessor;
