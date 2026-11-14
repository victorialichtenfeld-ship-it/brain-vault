// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Drip
/// @notice Hands each new vault a small amount of test coins so visitors can
/// use the public demo without a faucet. Only the sponsor account may ask for
/// a drip. The sponsor's key ships inside the public web page, so anyone could
/// use it: the contract therefore limits the damage, not the key. Each address
/// gets one drip, drips are capped per hour, and the sponsor account itself
/// only ever holds a small float, topped up from here. Test networks only.
contract Drip {
    uint256 public constant AMOUNT = 0.001 ether;        // per new vault
    uint256 public constant SPONSOR_FLOAT = 0.0005 ether; // the sponsor's gas money
    uint256 public constant PER_WINDOW = 20;             // drips per window
    uint256 public constant WINDOW = 1 hours;

    address public immutable owner;
    address public sponsor;
    uint256 public windowStart;
    uint256 public windowCount;
    mapping(address => bool) public dripped;

    event Dripped(address indexed to, uint256 amount, uint256 sponsorTopUp);
    event SponsorChanged(address indexed sponsor);

    error NotOwner();
    error NotSponsor();
    error AlreadyFunded();
    error RateLimited();
    error Empty();
    error ZeroAddress();
    error TransferFailed();

    constructor(address sponsor_) payable {
        if (sponsor_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        sponsor = sponsor_;
        emit SponsorChanged(sponsor_);
    }

    receive() external payable {}

    /// @notice Sends AMOUNT to `to` once, and refills the sponsor's gas money.
    function drip(address to) external {
        if (msg.sender != sponsor) revert NotSponsor();
        if (to == address(0)) revert ZeroAddress();
        if (dripped[to] || to.balance >= AMOUNT) revert AlreadyFunded();
        if (block.timestamp >= windowStart + WINDOW) {
            windowStart = block.timestamp;
            windowCount = 0;
        }
        if (++windowCount > PER_WINDOW) revert RateLimited();
        uint256 topUp = msg.sender.balance < SPONSOR_FLOAT ? SPONSOR_FLOAT - msg.sender.balance : 0;
        if (address(this).balance < AMOUNT + topUp) revert Empty();
        dripped[to] = true;
        emit Dripped(to, AMOUNT, topUp);
        _send(to, AMOUNT);
        if (topUp != 0) _send(msg.sender, topUp);
    }

    /// @notice Replaces the sponsor, e.g. after its key was abused.
    function setSponsor(address sponsor_) external {
        if (msg.sender != owner) revert NotOwner();
        if (sponsor_ == address(0)) revert ZeroAddress();
        sponsor = sponsor_;
        emit SponsorChanged(sponsor_);
    }

    /// @notice Returns coins to the owner.
    function withdraw(uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        _send(owner, amount);
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
